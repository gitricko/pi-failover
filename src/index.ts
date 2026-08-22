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
/**
 * Creates a wrapper around a stream that detects first token emission and
 * pre-first-token errors. Returns a NEW stream that the caller should consume;
 * events are forwarded verbatim EXCEPT a pre-token error event (which is
 * reported via onErrorBeforeFirstToken and NOT forwarded — the caller decides
 * the next step). On abort, the upstream consumption stops so iteration ends,
 * but the returned stream itself is left open for the caller to control.
 */
export function proxyFirstToken(
  stream: AssistantMessageEventStream,
  onFirstToken: () => void,
  onErrorBeforeFirstToken: (error: Error) => void,
  abortSignal?: AbortSignal,
): AssistantMessageEventStream {
  debug("proxyFirstToken: created proxy for stream");
  // Internal stream that the caller iterates. We push real events here.
  const inner = createAssistantMessageEventStream();
  let firstTokenEmitted = false;

  (async () => {
    try {
      debug("proxyFirstToken: starting to consume upstream stream");
      for await (const event of stream) {
        // pi-ai delivers provider failures as {type:"error"} events, not throws
        // (see lazy.js lazyStream catch: pushes error event + end). Detect that
        // BEFORE first token so failover can trigger.
        if (!firstTokenEmitted && event.type === "error") {
          debug("proxyFirstToken: pre-token error EVENT:", JSON.stringify(event.error));
          // Get the underlying cause for clearer logging
          const raw = (event.error as any)?.error ?? event.error;
          debug("proxyFirstToken: error stack:", (raw as Error)?.stack ?? "no stack");
          const err = new Error(event.error?.errorMessage ?? "pre-first-token error event");
          err.name = event.error?.stopReason === "aborted" ? "AbortError" : "ProviderError";
          onErrorBeforeFirstToken(err);
          // Do NOT forward the terminal error event — caller decides next step.
          // End the inner stream so the caller's for-await loop terminates.
          inner.end();
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
        inner.push(event);
      }
      debug("proxyFirstToken: upstream stream ended normally");
      // Leave inner open; caller's post-loop logic handles success/error.
      inner.end();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debug("proxyFirstToken: upstream error:", err.name, err.message);
      if (!firstTokenEmitted) {
        onErrorBeforeFirstToken(err);
      } else {
        // Error after first token — re-emit as error event on inner
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
        inner.push({ type: "error", reason: "error", error: errorMessage });
      }
      inner.end();
    }
  })();

  // On abort (timeout), stop consuming the upstream so the inner for-await ends.
  // We do NOT end `inner` here — the caller (failoverStreamSimple) owns the
  // lifecycle of the outer proxy and will push the fallback stream's events to it.
  if (abortSignal) {
    const onAbort = () => {
      debug("proxyFirstToken: abort received, ending inner stream");
      try { inner.end(); } catch { /* already ended */ }
    };
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  return inner;
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

  // Network errors (connection failed, DNS, timeout, reset, etc.) -> failover.
  // These are exactly the failures a pre-first-token failover extension exists to
  // catch: a dead/unreachable provider should switch to the next candidate, not be
  // retried on the same (broken) endpoint by Pi's own retry loop.
  const msg = error.message.toLowerCase();
  const NETWORK_SUBSTRINGS = [
    "fetch failed",
    "econnrefused",
    "enotfound",
    "eai_again",
    "network",
    "timeout",
    "connection error",
    "connect",
    "socket",
    "reset",
    "und_err",
    "name resolution",
  ];
  if (NETWORK_SUBSTRINGS.some((s) => msg.includes(s))) {
    debug("shouldFailover: network/connection error -> true (failover)");
    return true;
  }

  // Pre-first-token failover contract: if the primary provider failed to produce
  // ANY token (surfaced as an error event by pi-ai), we try the next candidate.
  // This includes both non-retryable (400 bad request, auth) and retryable
  // (rate limit, transient 5xx) errors — the user explicitly configured a fallback
  // chain to absorb the failure instead of bubbling it up. The only case we let
  // Pi handle is a successful first token (handled upstream), so here we fail over.
  debug("shouldFailover: pre-first-token error -> true (failover to next candidate)");
  return true;
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
 * @param rawStreamSimple - resolver returning the PRE-WRAP streamSimple for ANY provider id.
 *   Fallback candidates are always resolved through this so that a wrapped provider never
 *   calls another wrapped provider (which would recurse infinitely on circular configs).
 */
export function createFailoverWrapper(
  primaryProviderId: string,
  builtinStreamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  modelRegistry: ModelRegistry,
  fallbackConfig: FallbackConfig,
  rawStreamSimple: (providerId: string) => ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>) | undefined
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  debug("createFailoverWrapper: creating wrapper for provider:", primaryProviderId, "config:", fallbackConfig);
  
  // Resolve the raw streamSimple for a given provider id, preferring the
  // pre-wrap snapshot (rawStreamSimple) so we never re-enter a wrapped provider.
  const resolveRaw = (providerId: string) => {
    const r = rawStreamSimple(providerId);
    if (r) return r;
    // Fallback to the captured built-in (used for the primary provider itself)
    if (providerId === primaryProviderId) return builtinStreamSimple;
    return undefined;
  };

  return function failoverStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    debug("failoverStreamSimple: called with model:", model.provider, model.id, "hasOptions:", !!options);
    
    // Build candidate list: primary + fallback chain.
    // Each candidate carries its OWN streamSimple resolver. For the primary we use the
    // captured composed path; for fallback candidates we resolve through rawStreamSimple
    // so we never re-enter a wrapped provider (prevents infinite recursion on circular configs).
    const primaryModel = model;
    const candidates: Array<{
      model: Model<Api>;
      isFallback: boolean;
      displayName: string;
      streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
    }> = [
      { model: primaryModel, isFallback: false, displayName: primaryProviderId, streamSimple: builtinStreamSimple },
      ...fallbackConfig.chain
        .map((modelId) => {
          // Parse "provider/id" format
          const [providerId, ...modelIdParts] = modelId.split("/");
          const fullModelId = modelIdParts.join("/");
          const fallbackModel = modelRegistry.find(providerId, fullModelId);
          if (!fallbackModel) return null;
          const raw = resolveRaw(providerId);
          if (!raw) {
            debug("failoverStreamSimple: no raw streamSimple for fallback provider", providerId, "- skipping");
            return null;
          }
          return { model: fallbackModel, isFallback: true, displayName: modelId, streamSimple: raw };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
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
        // Use a const reference to avoid TS narrowing issues
        let preTokenErrorRef: { current: Error | null } = { current: null };
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

          // Call the candidate's OWN streamSimple (raw path — never wrapped) for this attempt
          debug("failoverStreamSimple: calling candidate streamSimple for", candidate.displayName);

          // Try the candidate model
          const stream = await candidate.streamSimple(candidate.model, context, streamOptions);
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
              preTokenErrorRef.current = error;
            },
            mergedSignal
          );

          // Consume the wrapped stream and push to proxy
          debug("failoverStreamSimple: consuming wrapped stream for", candidate.displayName);
          let eventCount = 0;
          for await (const event of wrappedStream) {
            eventCount++;
            proxy.push(event);
          }
          debug("failoverStreamSimple: for-await loop completed for", candidate.displayName, "events:", eventCount, "preTokenErrorRef:", preTokenErrorRef.current, "aborted:", abortController.signal.aborted);
          // If we get here, the stream completed successfully
          // BUT check if we captured a pre-token error event (pi-ai delivers failures as events)
          if (preTokenErrorRef.current != null) {
            debug("failoverStreamSimple: stream ended with pre-token error:", preTokenErrorRef.current.message);
            throw preTokenErrorRef.current;
          }
          // If the candidate was aborted (timeout) without producing a single token,
          // treat it as a failover trigger — BUT only if there's a next candidate.
          // Do NOT end the main proxy here; the next candidate will push to it.
          if (abortController.signal.aborted) {
            debug("failoverStreamSimple: candidate aborted (timeout) before first token -", i < candidates.length - 1 ? "will fail over" : "no fallback");
            if (i < candidates.length - 1) {
              const timeoutErr = new Error(`timeout after ${fallbackConfig.timeoutMs}ms before first token`);
              timeoutErr.name = "AbortError";
              throw timeoutErr;
            }
          }
          debug("failoverStreamSimple: stream completed successfully for", candidate.displayName);
          proxy.end();
          return;
        } catch (streamError) {
          const err = preTokenErrorRef.current ?? (streamError instanceof Error ? streamError : new Error(String(streamError)));
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
  const wrapProviderIfNeeded = async (
    ctx: ExtensionContext,
    providerId: string,
    allModels: Model<Api>[],
    rawStreamSimple: (providerId: string) => ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>) | undefined
  ) => {
    const modelRegistry = ctx.modelRegistry;
    // Cast to access private runtime.config.getProvider for models.json fallback config
    const fallbackConfig = loadFallbackConfigForProvider(providerId, modelRegistry as any);

    if (fallbackConfig.chain.length === 0) {
      return; // No fallback chain for this provider — skip silently
    }

    // Only log once we know there's real work to do
    debug("wrapProviderIfNeeded: provider", providerId, "has fallback chain:", fallbackConfig.chain);

    // Check if this provider has any models
    const providerModels = allModels.filter(m => m.provider === providerId);
    if (providerModels.length === 0) {
      debug("wrapProviderIfNeeded: no models for provider", providerId, "- skipping");
      return;
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

    // Create the failover wrapper bound to the CAPTURED built-in path
    const failoverStreamSimple = createFailoverWrapper(providerId, builtinStreamSimple, modelRegistry, fallbackConfig, rawStreamSimple);
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

  // On session start, check all providers for fallback config and wrap them.
  // We first capture a RAW snapshot of every provider's streamSimple (pre-wrap),
  // then re-register each wrapped provider. Fallback candidates resolve through the
  // raw snapshot, so a wrapped provider never calls another wrapped provider.
  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    debug("session_start event received!");
    const modelRegistry = ctx.modelRegistry;

    // Build the full model list ONCE (not per-provider)
    let allModels: Model<Api>[] = [];
    try {
      allModels = modelRegistry.getAll() as Model<Api>[];
      debug("session_start: registry has", allModels.length, "models across",
            new Set(allModels.map(m => m.provider)).size, "providers");
    } catch (e) {
      debugError("session_start: getAll() threw:", e instanceof Error ? e.message : e);
      return;
    }

    // Source: every provider that has at least one model in the registry
    // (covers both extension-registered providers AND models.json providers)
    const providerIds = [...new Set(allModels.map(m => m.provider))];
    debug("session_start: candidate provider IDs:", providerIds);
    
    // RAW snapshot: capture each provider's composed streamSimple BEFORE any
    // re-registration. Wrapped providers will resolve their fallback candidates
    // through this snapshot, breaking recursion (e.g. circular configs).
    const rawStreamSimpleMap = new Map<string, (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>>();
    for (const providerId of providerIds) {
      const p = modelRegistry.getProvider(providerId);
      if (p?.streamSimple) {
        rawStreamSimpleMap.set(providerId, p.streamSimple.bind(p));
      }
    }
    debug("session_start: captured raw streamSimple for", rawStreamSimpleMap.size, "providers");

    const rawStreamSimpleResolver = (providerId: string) => rawStreamSimpleMap.get(providerId);

    for (const providerId of providerIds) {
      await wrapProviderIfNeeded(ctx, providerId, allModels, rawStreamSimpleResolver);
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