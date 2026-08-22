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

// Debug flag - enable via DEBUG=pi-failover or DEBUG=* environment variable
const DEBUG = process.env.DEBUG === "*" || (process.env.DEBUG?.includes("pi-failover") ?? false);

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log("[pi-failover:debug]", new Date().toISOString(), ...args);
  }
}

function debugWarn(...args: unknown[]) {
  if (DEBUG) {
    console.warn("[pi-failover:warn]", new Date().toISOString(), ...args);
  }
}

function debugError(...args: unknown[]) {
  if (DEBUG) {
    console.error("[pi-failover:error]", new Date().toISOString(), ...args);
  }
}

/** Build a terminal error AssistantMessage for pushing an {type:"error"} event. */
function makeErrorMessage(api: Api, model: string, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: "unknown" as any,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

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
  debug("proxyFirstToken: created proxy for stream");
  const proxy = createAssistantMessageEventStream();
  let firstTokenEmitted = false;

  (async () => {
    try {
      debug("proxyFirstToken: starting to consume upstream stream");
      for await (const event of stream) {
        // pi-ai delivers provider failures as {type:"error"} events, not throws
        // (see lazy.js lazyStream catch: pushes error event + end). Detect that
        // BEFORE first token so failover can trigger.
        if (!firstTokenEmitted && event.type === "error") {
          debug("proxyFirstToken: pre-token error EVENT:", event.error?.errorMessage ?? "unknown");
          const err = new Error(event.error?.errorMessage ?? "pre-first-token error event");
          err.name = event.error?.stopReason === "aborted" ? "AbortError" : "ProviderError";
          onErrorBeforeFirstToken(err);
          // Do NOT forward the terminal error event — caller decides next step
          return;
        }
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
            debug("proxyFirstToken: first token emitted, type:", event.type);
            onFirstToken();
          }
        }
        proxy.push(event);
      }
      debug("proxyFirstToken: upstream stream ended normally");
      proxy.end();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debug("proxyFirstToken: upstream error:", err.name, err.message);
      if (!firstTokenEmitted) {
        debug("proxyFirstToken: error before first token, calling onErrorBeforeFirstToken");
        onErrorBeforeFirstToken(err);
      } else {
        // If error after first token, push error event to proxy
        debug("proxyFirstToken: error after first token, pushing error event to proxy");
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
          errorMessage: err.message,
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
  debug("shouldFailover: checking error:", error.name, error.message);
  
  // AbortError from our timeout -> failover
  if (error.name === "AbortError" || error.name === "CancellationError") {
    debug("shouldFailover: AbortError/CancellationError -> true (failover)");
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
    debug("shouldFailover: network/timeout error -> true (failover)");
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
  const retryable = isRetryableAssistantError(errorMessage);
  debug("shouldFailover: isRetryableAssistantError:", retryable);
  if (!retryable) {
    debug("shouldFailover: non-retryable by Pi -> true (failover)");
    return true;
  }

  // Context overflow is also non-retryable in the same way
  const contextOverflow = isContextOverflow(errorMessage);
  debug("shouldFailover: isContextOverflow:", contextOverflow);
  if (contextOverflow) {
    debug("shouldFailover: context overflow -> true (failover)");
    return true;
  }

  // Otherwise it's retryable - let Pi handle it
  debug("shouldFailover: retryable by Pi -> false (no failover)");
  return false;
}

/**
 * Creates a failover streamSimple that wraps the built-in streamSimple.
 * This is the core implementation matching the architecture diagram.
 * 
 * @param primaryProviderId - the provider being wrapped
 * @param builtinStreamSimple - the CAPTURED composed streamSimple (before our re-registration)
 *   This is critical: calling modelRegistry.getProvider(id).streamSimple after re-registration
 *   would return our wrapper, causing infinite recursion.
 * @param modelRegistry - for resolving fallback chain models
 * @param fallbackConfig - fallback chain configuration
 */
export function createFailoverWrapper(
  primaryProviderId: string,
  builtinStreamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  modelRegistry: ModelRegistry,
  fallbackConfig: FallbackConfig
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  debug("createFailoverWrapper: creating wrapper for provider:", primaryProviderId, "config:", fallbackConfig);
  
  // Get the built-in streamSimple for any model — now injected, not looked up by closure.
  // The injected function is the CAPTURED composed path, so it bypasses our wrapper.

  return function failoverStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    debug("failoverStreamSimple: called with model:", model.provider, model.id, "hasOptions:", !!options);
    
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

    debug("failoverStreamSimple: candidates:", candidates.map(c => `${c.displayName} (fallback=${c.isFallback})`));

    if (candidates.length === 1 && !candidates[0].isFallback) {
      // No fallback chain configured - pass through to primary's built-in streamSimple
      debug("failoverStreamSimple: no fallback chain, passing through to captured built-in");
      const stream = builtinStreamSimple(primaryModel, context, options);
      if (stream instanceof Promise) {
        // Rare sync-return contract: wrap the async resolution in our own proxy pump
        const proxy = createAssistantMessageEventStream();
        Promise.resolve(stream)
          .then(s => {
            (async () => {
              try {
                for await (const event of s) proxy.push(event);
                proxy.end();
              } catch (e) {
                debugError("failoverStreamSimple: passthrough stream error:", e instanceof Error ? e.message : e);
                proxy.push({ type: "error", reason: "error", error: makeErrorMessage("unknown" as Api, "unknown", e instanceof Error ? e.message : String(e)) } as any);
                proxy.end();
              }
            })();
          })
          .catch(e => {
            debugError("failoverStreamSimple: passthrough error:", e instanceof Error ? e.message : e);
            proxy.push({ type: "error", reason: "error", error: makeErrorMessage("unknown" as Api, "unknown", e instanceof Error ? e.message : String(e)) } as any);
            proxy.end();
          });
        return proxy;
      }
      return stream;
    }

    // We'll create the stream synchronously and handle the async iteration internally
    const proxy = createAssistantMessageEventStream();
    let lastError: Error | null = null;

    (async () => {
      debug("failoverStreamSimple: starting async fallback loop,", candidates.length, "candidates");
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const isPrimary = !candidate.isFallback;
        debug("failoverStreamSimple: trying candidate", i + 1, "/", candidates.length, ":", candidate.displayName, "(primary:", isPrimary, ")");

        // Create AbortController for this attempt
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
          debug("failoverStreamSimple: timeout fired for", candidate.displayName, "after", fallbackConfig.timeoutMs, "ms");
          abortController.abort();
        }, fallbackConfig.timeoutMs);

        // Track if we've already cleaned up abort listeners
        let abortCleanedUp = false;
        // Pre-first-token error captured from an error EVENT (pi-ai style failure)
        let preTokenError: Error | null = null;
        const cleanupAbortListeners = () => {
          if (abortCleanedUp) return;
          abortCleanedUp = true;
          debug("failoverStreamSimple: cleanupAbortListeners for", candidate.displayName);
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

          // Call the CAPTURED built-in streamSimple for this candidate
          debug("failoverStreamSimple: calling captured builtinStreamSimple for", candidate.displayName);

          // Try the candidate model
          const stream = await builtinStreamSimple(candidate.model, context, streamOptions);
          debug("failoverStreamSimple: builtinStreamSimple returned stream for", candidate.displayName);

          // Wrap stream with first-token detection.
          // NOTE: proxyFirstToken converts pre-token error EVENTS into thrown errors
          // (via onErrorBeforeFirstToken) so the catch below can evaluate failover.
          const wrappedStream = proxyFirstToken(
            stream,
            () => {
              // First token emitted - clear timeout, we're committed to this stream
              debug("failoverStreamSimple: first token from", candidate.displayName, "- committing");
              cleanupAbortListeners();
            },
            (error) => {
              // Error before first token - clear timeout and signal failover decision
              debug("failoverStreamSimple: error before first token from", candidate.displayName, ":", error.name, error.message);
              cleanupAbortListeners();
              preTokenError = error;
            }
          );

          // Consume the wrapped stream and push to proxy
          try {
            preTokenError = null;
            debug("failoverStreamSimple: consuming wrapped stream for", candidate.displayName);
            for await (const event of wrappedStream) {
              proxy.push(event);
            }
            // If we get here, the stream completed successfully
            debug("failoverStreamSimple: stream completed successfully for", candidate.displayName);
            proxy.end();
            return;
          } catch (streamError) {
            const err = preTokenError ?? (streamError instanceof Error ? streamError : new Error(String(streamError)));
            debug("failoverStreamSimple: stream error for", candidate.displayName, ":", err.name, err.message);
            cleanupAbortListeners();
            
            if (i < candidates.length - 1 && shouldFailover(err, fallbackConfig)) {
              // Notify on switch if configured
              if (fallbackConfig.notifyOnSwitch) {
                const fromName = candidates[i].displayName;
                const toName = candidates[i + 1].displayName;
                debugWarn("⚠ failover:", fromName, "→", toName, "(", err.name, ":", err.message, ")");
              }
              lastError = err;
              debug("failoverStreamSimple: will try next candidate");
              continue; // Try next candidate
            }

            // Don't failover - re-throw via proxy
            debug("failoverStreamSimple: not failing over, pushing error to proxy");
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
          debug("failoverStreamSimple: caught error for", candidate.displayName, ":", err.name, err.message);
          lastError = err;

          // Check if we should failover to next candidate
          if (i < candidates.length - 1 && shouldFailover(err, fallbackConfig)) {
            // Notify on switch if configured
            if (fallbackConfig.notifyOnSwitch) {
              const fromName = candidates[i].displayName;
              const toName = candidates[i + 1].displayName;
              debugWarn("⚠ failover:", fromName, "→", toName, "(", err.name, ":", err.message, ")");
            }
            debug("failoverStreamSimple: will try next candidate after catch");
            continue; // Try next candidate
          }

          // Don't failover - re-throw via proxy
          debug("failoverStreamSimple: not failing over after catch, pushing error to proxy");
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
      debugError("failoverStreamSimple: ALL candidates exhausted");
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
 * Strategy: On session_start, discover all providers that have fallback config.
 * Provider discovery uses TWO sources:
 *   1. modelRegistry.getRegisteredProviderIds() — extension-registered providers only
 *   2. modelRegistry.getAll() — ALL models incl. those from models.json (dedup provider names)
 *
 * For each provider with a fallback chain, we capture the CURRENT composed streamSimple
 * (the real built-in path, before our re-registration) and re-register the provider with
 * our wrapper that delegates to the captured function for each candidate.
 */
export default async function (pi: ExtensionAPI) {
  debug("pi-failover extension loaded!");
  
  // Helper to wrap a provider with failover if it has fallback config
  // This runs inside session_start handler where we have access to ExtensionContext
  const wrapProviderIfNeeded = async (ctx: ExtensionContext, providerId: string) => {
    debug("wrapProviderIfNeeded: checking provider:", providerId);
    const modelRegistry = ctx.modelRegistry;
    // Cast to access private runtime.config.getProvider for models.json fallback config
    const fallbackConfig = loadFallbackConfigForProvider(providerId, modelRegistry as any);
    debug("wrapProviderIfNeeded: fallback config for", providerId, ":", fallbackConfig);
    
    if (fallbackConfig.chain.length === 0) {
      debug("wrapProviderIfNeeded: no fallback chain for", providerId, "- skipping");
      return; // No fallback chain for this provider
    }

    // Check if this provider has any models
    const allModels = modelRegistry.getAll();
    debug("wrapProviderIfNeeded: all models in registry:", allModels.length);
    const providerModels = allModels.filter(m => m.provider === providerId);
    debug("wrapProviderIfNeeded: models for provider", providerId, ":", providerModels.map(m => m.id));
    if (providerModels.length === 0) {
      debug("wrapProviderIfNeeded: no models for provider", providerId, "- skipping");
      return; // No models to wrap
    }

    // CRITICAL: capture the composed provider's streamSimple BEFORE we re-register.
    // After pi.registerProvider(..., { streamSimple }), registry.getProvider(id).streamSimple
    // IS our wrapper — calling it from inside would recurse infinitely.
    const composedProvider = modelRegistry.getProvider(providerId);
    const builtinStreamSimple = composedProvider?.streamSimple?.bind(composedProvider);
    debug("wrapProviderIfNeeded: composed provider for", providerId, ":", !!composedProvider,
          "hasStreamSimple:", !!builtinStreamSimple);

    if (!builtinStreamSimple) {
      debugError("wrapProviderIfNeeded: no composed streamSimple for", providerId, "- skipping");
      return;
    }

    // Get the existing registered config (only what extensions previously registered;
    // models.json fields like baseUrl/apiKey are merged by Pi itself)
    const existingConfig = modelRegistry.getRegisteredProviderConfig(providerId);
    debug("wrapProviderIfNeeded: existing extension config for", providerId, ":", existingConfig ? Object.keys(existingConfig) : "none");

    // Create the failover wrapper bound to the CAPTURED built-in path
    const failoverStreamSimple = createFailoverWrapper(providerId, builtinStreamSimple, modelRegistry, fallbackConfig);
    debug("wrapProviderIfNeeded: created failover wrapper for", providerId);

    // Re-register with explicit api (required by validateExtensionProvider when
    // streamSimple is present) + preserved baseUrl/apiKey/compat from models.json
    const modelsJsonConfig = (modelRegistry as any).runtime?.config?.getProvider?.(providerId) ?? {};
    const registration = {
      ...modelsJsonConfig,
      ...existingConfig,
      api: providerModels[0].api,
      streamSimple: failoverStreamSimple,
    };
    debug("wrapProviderIfNeeded: re-registering provider", providerId, "with keys:", Object.keys(registration));
    try {
      pi.registerProvider(providerId, registration as any);
      debug("wrapProviderIfNeeded: provider", providerId, "wrapped successfully!");
    } catch (err) {
      debugError("wrapProviderIfNeeded: registerProvider FAILED for", providerId, ":", err instanceof Error ? err.message : err);
    }
  };

  // On session start, check all providers for fallback config and wrap them
  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    debug("session_start event received!");
    const modelRegistry = ctx.modelRegistry;

    // Source 1: extension-registered providers
    const registeredIds = [...(modelRegistry.getRegisteredProviderIds?.() ?? [])];
    debug("session_start: extension-registered provider IDs:", registeredIds);

    // Source 2: providers implied by models in the registry (covers models.json providers)
    let modelProviderIds: string[] = [];
    try {
      const allModels = modelRegistry.getAll();
      debug("session_start: getAll() returned:", allModels.length, "models");
      modelProviderIds = [...new Set(allModels.map(m => m.provider))];
      debug("session_start: provider IDs from models:", modelProviderIds);
    } catch (e) {
      debugError("session_start: getAll() threw:", e instanceof Error ? e.message : e);
    }

    const providerIds = [...new Set([...registeredIds, ...modelProviderIds])];
    debug("session_start: all candidate provider IDs:", providerIds);
    
    for (const providerId of providerIds) {
      debug("session_start: processing provider:", providerId);
      await wrapProviderIfNeeded(ctx, providerId);
    }
  });

  // Clean up status on shutdown
  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    debug("session_shutdown event received");
    // ExtensionContext has UI access
    if (ctx.ui) {
      ctx.ui.setStatus("failover", undefined);
    }
  });
}