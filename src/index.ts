/**
 * pi-failover — True Hermes-style request-time model failover for Pi
 * 
 * This extension wraps a primary provider's streamSimple and, on pre-first-token failure
 * (timeout, connection error, 5xx, or non-retryable error), re-issues the exact same
 * request against a configured fallback chain using Pi's built-in streamSimple.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
  Api,
  AssistantMessageEvent,
  AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import { loadFallbackConfigForProvider, type FallbackConfig } from "./config.js";

/**
 * Creates a proxy for an AssistantMessageEventStream that detects first token emission.
 * Once a token is emitted, the proxy passes through all events untouched.
 * If an error occurs before first token, the proxy can signal that fallback should be attempted.
 */
export function proxyFirstToken(
  stream: AssistantMessageEventStream,
  onFirstToken: () => void,
  onErrorBeforeFirstToken: (error: Error) => void
): AssistantMessageEventStream {
  const proxy = createAssistantMessageEventStream();
  let firstTokenEmitted = false;

  (async () => {
    try {
      for await (const event of stream) {
        // Check if this event represents first token emission
        if (!firstTokenEmitted) {
          if (
            event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "toolcall_delta" ||
            event.type === "text_start" ||
            event.type === "thinking_start" ||
            event.type === "toolcall_start"
          ) {
            firstTokenEmitted = true;
            onFirstToken();
          }
        }
        proxy.push(event);
      }
      proxy.end();
    } catch (error) {
      if (!firstTokenEmitted) {
        onErrorBeforeFirstToken(error instanceof Error ? error : new Error(String(error)));
      } else {
        // If error after first token, push error event to proxy
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [],
          api: "unknown" as Api,
          provider: "unknown" as any,
          model: "unknown",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        proxy.push({
          type: "error",
          reason: "error",
          error: errorMessage,
        });
        proxy.end();
      }
    }
  })();

  return proxy;
}

/**
 * Determines if an error should trigger failover (pre-first-token only).
 * Reuses Pi's error classification to match Pi's own retry behavior.
 */
export function shouldFailover(error: Error, fallbackConfig: FallbackConfig): boolean {
  // AbortError from our timeout -> failover
  if (error.name === "AbortError" || error.name === "CancellationError") {
    return true;
  }

  // Network errors (connection failed, DNS, etc.) -> failover
  if (
    error.message.includes("fetch failed") ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("EAI_AGAIN") ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  ) {
    return true;
  }

  // Use Pi's error classification for retryable vs non-retryable
  // We need to construct a minimal AssistantMessage from the error to check
  const errorMessage: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "unknown" as Api,
    provider: "unknown" as any,
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error.message,
    timestamp: Date.now(),
  };

  // If it's NOT retryable by Pi's standards, we should failover
  // If it IS retryable, let Pi handle the retry
  if (!isRetryableAssistantError(errorMessage)) {
    return true;
  }

  // Context overflow is also non-retryable in the same way
  if (isContextOverflow(errorMessage)) {
    return true;
  }

  // Otherwise it's retryable - let Pi handle it
  return false;
}

/**
 * Creates a failover streamSimple that wraps the built-in streamSimple.
 * This is the core implementation matching the architecture diagram.
 */
export function createFailoverWrapper(
  primaryProviderId: string,
  modelRegistry: ModelRegistry,
  fallbackConfig: FallbackConfig
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  // Get the built-in streamSimple for any model
  // We access it through the model registry's internal runtime
  const getBuiltinStreamSimple = (model: Model<Api>) => {
    // The model registry has access to the model runtime which has streamSimple
    const runtime = (modelRegistry as any).runtime;
    if (runtime?.streamSimple) {
      return runtime.streamSimple.bind(runtime);
    }
    // Fallback: try to get from provider directly
    const provider = modelRegistry.getProvider(model.provider);
    if (provider?.streamSimple) {
      return provider.streamSimple.bind(provider);
    }
    throw new Error("No built-in streamSimple available");
  };

  return function failoverStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    // Build candidate list: primary + fallback chain
    const primaryModel = model;
    const candidates: Array<{ model: Model<Api>; isFallback: boolean; displayName: string }> = [
      { model: primaryModel, isFallback: false, displayName: primaryProviderId },
      ...fallbackConfig.chain
        .map((modelId) => {
          // Parse "provider/id" format
          const [providerId, ...modelIdParts] = modelId.split("/");
          const fullModelId = modelIdParts.join("/");
          const fallbackModel = modelRegistry.find(providerId, fullModelId);
          return fallbackModel ? { model: fallbackModel, isFallback: true, displayName: modelId } : null;
        })
        .filter((c): c is { model: Model<Api>; isFallback: boolean; displayName: string } => c !== null),
    ];

    if (candidates.length === 1 && !candidates[0].isFallback) {
      // No fallback chain configured - pass through to primary's built-in streamSimple
      const builtinStreamSimple = getBuiltinStreamSimple(primaryModel);
      return builtinStreamSimple(primaryModel, context, options);
    }

    // We'll create the stream synchronously and handle the async iteration internally
    const proxy = createAssistantMessageEventStream();
    let lastError: Error | null = null;

    (async () => {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const isPrimary = !candidate.isFallback;

        // Create AbortController for this attempt
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), fallbackConfig.timeoutMs);

        // Track if we've already cleaned up abort listeners
        let abortCleanedUp = false;
        const cleanupAbortListeners = () => {
          if (abortCleanedUp) return;
          abortCleanedUp = true;
          clearTimeout(timeoutId);
        };

        try {
          // Merge our abort signal with any existing signal from options
          let mergedSignal: AbortSignal;
          if (options?.signal) {
            const controller = new AbortController();
            const abortHandler = () => controller.abort();
            options.signal.addEventListener("abort", abortHandler, { once: true });
            abortController.signal.addEventListener("abort", abortHandler, { once: true });
            mergedSignal = controller.signal;
          } else {
            mergedSignal = abortController.signal;
          }

          const streamOptions: SimpleStreamOptions = {
            ...options,
            signal: mergedSignal,
          };

          // Get built-in streamSimple for this candidate
          const builtinStreamSimple = getBuiltinStreamSimple(candidate.model);

          // Try the candidate model
          const stream = await builtinStreamSimple(candidate.model, context, streamOptions);

          // Wrap stream with first-token detection
          const wrappedStream = proxyFirstToken(
            stream,
            () => {
              // First token emitted - clear timeout, we're committed to this stream
              cleanupAbortListeners();
            },
            (error) => {
              // Error before first token - clear timeout and continue to next candidate
              cleanupAbortListeners();
              throw error;
            }
          );

          // Consume the wrapped stream and push to proxy
          try {
            for await (const event of wrappedStream) {
              proxy.push(event);
            }
            // If we get here, the stream completed successfully
            proxy.end();
            return;
          } catch (streamError) {
            // Stream error - check if it was before first token
            const err = streamError instanceof Error ? streamError : new Error(String(streamError));
            cleanupAbortListeners();
            
            if (i < candidates.length - 1 && shouldFailover(err, fallbackConfig)) {
              // Notify on switch if configured
              if (fallbackConfig.notifyOnSwitch) {
                const fromName = candidates[i].displayName;
                const toName = candidates[i + 1].displayName;
                console.warn(`⚠ failover: ${fromName} → ${toName} (${err.name}: ${err.message})`);
              }
              lastError = err;
              continue; // Try next candidate
            }

            // Don't failover - re-throw via proxy
            lastError = err;
            const errorMessage: AssistantMessage = {
              role: "assistant",
              content: [],
              api: "unknown" as Api,
              provider: "unknown" as any,
              model: candidate.model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: err.message,
              timestamp: Date.now(),
            };
            proxy.push({
              type: "error",
              reason: "error",
              error: errorMessage,
            });
            proxy.end();
            return;
          }
        } catch (error) {
          cleanupAbortListeners();

          const err = error instanceof Error ? error : new Error(String(error));
          lastError = err;

          // Check if we should failover to next candidate
          if (i < candidates.length - 1 && shouldFailover(err, fallbackConfig)) {
            // Notify on switch if configured
            if (fallbackConfig.notifyOnSwitch) {
              const fromName = candidates[i].displayName;
              const toName = candidates[i + 1].displayName;
              console.warn(`⚠ failover: ${fromName} → ${toName} (${err.name}: ${err.message})`);
            }
            continue; // Try next candidate
          }

          // Don't failover - re-throw via proxy
          const errorMessage: AssistantMessage = {
            role: "assistant",
            content: [],
            api: "unknown" as Api,
            provider: "unknown" as any,
            model: candidate.model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: err.message,
            timestamp: Date.now(),
          };
          proxy.push({
            type: "error",
            reason: "error",
            error: errorMessage,
          });
          proxy.end();
          return;
        }
      }

      // All candidates exhausted - push final error
      const finalError = lastError || new Error("All fallback candidates exhausted");
      const errorMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "unknown" as Api,
        provider: "unknown" as any,
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: finalError.message,
        timestamp: Date.now(),
      };
      proxy.push({
        type: "error",
        reason: "error",
        error: errorMessage,
      });
      proxy.end();
    })();

    return proxy;
  };
}

/**
 * Extension factory - entry point for pi-failover
 * 
 * Strategy: On session_start, scan all registered providers for fallback config.
 * For each provider with a fallback chain, re-register it with a wrapped streamSimple
 * that implements the failover logic.
 */
export default async function (pi: ExtensionAPI) {
  // Helper to wrap a provider with failover if it has fallback config
  // This runs inside session_start handler where we have access to ExtensionContext
  const wrapProviderIfNeeded = async (ctx: ExtensionContext, providerId: string) => {
    const modelRegistry = ctx.modelRegistry;
    const fallbackConfig = loadFallbackConfigForProvider(providerId, modelRegistry);
    
    if (fallbackConfig.chain.length === 0) {
      return; // No fallback chain for this provider
    }

    // Check if this provider has any models
    const allModels = modelRegistry.getAll();
    const providerModels = allModels.filter(m => m.provider === providerId);
    if (providerModels.length === 0) {
      return; // No models to wrap
    }

    // Get the existing provider config (built-in + models.json + any previous extension config)
    const existingConfig = modelRegistry.getRegisteredProviderConfig(providerId);
    
    // Create the failover wrapper
    const failoverStreamSimple = createFailoverWrapper(providerId, modelRegistry, fallbackConfig);

    // Re-register the provider with our wrapped streamSimple
    // We preserve all existing config and just replace streamSimple
    pi.registerProvider(providerId, {
      ...existingConfig,
      streamSimple: failoverStreamSimple,
    });
  };

  // On session start, check all providers for fallback config and wrap them
  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    const modelRegistry = ctx.modelRegistry;
    const providerIds = modelRegistry.getRegisteredProviderIds?.() ?? [];
    
    for (const providerId of providerIds) {
      await wrapProviderIfNeeded(ctx, providerId);
    }
  });

  // Clean up status on shutdown
  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    // ExtensionContext has UI access
    if (ctx.ui) {
      ctx.ui.setStatus("failover", undefined);
    }
  });
}