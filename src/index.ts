/**
 * pi-failover — Hermes-style request-time model failover for Pi
 * 
 * This extension wraps the primary model's streamSimple and, on a pre-first-token
 * failure (timeout, connection error, 5xx, or non-retryable error), re-issues
 * the exact same request against a configured fallback chain.
 */

import type {
  Model,
  Context,
  AssistantMessageEventStream,
  AssistantMessageEvent,
  SimpleStreamOptions,
  Api,
  StreamFunction,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError, isContextOverflow } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

// ============================================================================
// Configuration Types
// ============================================================================

export interface FallbackConfig {
  chain: string[];              // Ordered fallback model IDs ("provider/id")
  timeoutMs: number;            // Per-request first-token timeout
  onlyPreFirstToken: boolean;   // Only failover before first token (safety)
  notifyOnSwitch: boolean;      // Show status bar notice on switch
}

interface FallbackConfigInput {
  chain?: string[];
  timeoutMs?: number;
  onlyPreFirstToken?: boolean;
  notifyOnSwitch?: boolean;
}

const DEFAULT_FALLBACK_CONFIG: Required<FallbackConfig> = {
  chain: [],
  timeoutMs: 30000,
  onlyPreFirstToken: true,
  notifyOnSwitch: true,
};

// ============================================================================
// State (per-provider)
// ============================================================================

export interface ProviderFallbackState {
  config: FallbackConfig;
  models: Model<Api>[];
}

// Observability counters (per session)
export interface FailoverMetrics {
  switches: number;
  latencySavedMs: number;
  lastSwitch?: {
    from: string;
    to: string;
    reason: string;
    timestamp: number;
    primaryLatencyMs: number;
  };
}

const providerStates = new Map<string, ProviderFallbackState>();
const metrics = new Map<string, FailoverMetrics>();
let builtinStreamSimple: StreamFunction | null = null;
let currentContext: ExtensionContext | null = null;

// ============================================================================
// Fallback Chain Resolution
// ============================================================================

function resolveFallbackChain(
  modelRegistry: ExtensionContext["modelRegistry"],
  config: FallbackConfig
): Model<Api>[] {
  const chain: Model<Api>[] = [];
  
  for (const modelId of config.chain) {
    const [provider, ...modelParts] = modelId.split("/");
    const modelName = modelParts.join("/");
    
    const model = modelRegistry.find(provider, modelName);
    if (model) {
      chain.push(model);
    } else {
      console.warn(`[pi-failover] Fallback model not found: ${modelId} (provider: ${provider}, model: ${modelName})`);
    }
  }
  
  return chain;
}

// ============================================================================
// Stream Wrapper - Detects First Token
// ============================================================================

interface ProxyState {
  firstTokenEmitted: boolean;
  onFirstToken: () => void;
}

function wrapStreamWithFirstTokenDetection(
  stream: AssistantMessageEventStream,
  state: ProxyState
): AssistantMessageEventStream {
  const resultStream = createAssistantMessageEventStream();
  
  // Consume the original stream and forward events
  (async () => {
    try {
      for await (const event of stream) {
        // Check if this is a first token event
        if (!state.firstTokenEmitted && isFirstTokenEvent(event)) {
          state.firstTokenEmitted = true;
          state.onFirstToken();
        }
        resultStream.push(event);
      }
      // Stream completed successfully
      const finalResult = await stream.result();
      resultStream.end(finalResult);
    } catch (error) {
      // Stream errored
      if (error && typeof error === "object" && "stopReason" in error) {
        resultStream.end(error as any);
      } else {
        // Wrap in an error message
        resultStream.end({
          role: "assistant",
          content: [],
          api: "openai-completions" as Api,
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        } as any);
      }
    }
  })();
  
  return resultStream;
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
  // First token events are text_delta, text_start, or toolcall_start (side effect)
  return (
    event.type === "text_delta" ||
    event.type === "text_start" ||
    event.type === "toolcall_start"
  );
}

// ============================================================================
// Error Classification
// ============================================================================

function shouldFailover(error: unknown, state: ProxyState, config: FallbackConfig): boolean {
  // If we already emitted tokens and onlyPreFirstToken is true, don't failover
  if (config.onlyPreFirstToken && state.firstTokenEmitted) {
    return false;
  }
  
  // AbortError from our timeout
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  
  // Network/connection errors
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  
  // AssistantMessage with error stopReason
  if (error && typeof error === "object" && "stopReason" in error) {
    const msg = error as { stopReason: string; errorMessage?: string };
    
    if (msg.stopReason === "error" && msg.errorMessage) {
      // Non-retryable errors (quota, billing, etc.) - failover
      if (!isRetryableAssistantError(msg as any)) {
        return true;
      }
      // Context overflow - failover (different model might have larger context)
      if (isContextOverflow(msg as any)) {
        return true;
      }
      // Retryable errors (429, 5xx, network) - let Pi's retry handle these
      return false;
    }
    
    if (msg.stopReason === "aborted") {
      // User abort - don't failover
      return false;
    }
  }
  
  return false;
}

// ============================================================================
// Main Failover Stream Function - synchronous, returns stream directly
// ============================================================================

export function failoverStreamSimple(
  primaryModel: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined
): AssistantMessageEventStream {
  // Get the provider state for this model's provider
  const providerState = providerStates.get(primaryModel.provider);
  if (!providerState || !builtinStreamSimple) {
    // No fallback configured for this provider - pass through to builtin
    return builtinStreamSimple!(primaryModel, context, options);
  }
  
  const { config: fallbackConfig, models: fallbackModels } = providerState;
  const candidates = [primaryModel, ...fallbackModels];
  
  // Create the result stream that will handle failover internally
  const resultStream = createAssistantMessageEventStream();
  
  // Track timing for observability
  const attemptStartTimes = new Map<number, number>();
  const primaryStartTime = Date.now();
  attemptStartTimes.set(0, primaryStartTime);
  
  // Get or initialize metrics for this provider
  let providerMetrics = metrics.get(primaryModel.provider);
  if (!providerMetrics) {
    providerMetrics = { switches: 0, latencySavedMs: 0 };
    metrics.set(primaryModel.provider, providerMetrics);
  }
  
  // This async function handles the failover chain
  (async () => {
    let lastError: unknown;
    
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const isPrimary = i === 0;
      
      if (!isPrimary) {
        attemptStartTimes.set(i, Date.now());
      }
      
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, fallbackConfig.timeoutMs);
      
      // Thread user abort signal into our controller
      const userAbortHandler = () => abortController.abort();
      const userSignal = options?.signal;
      userSignal?.addEventListener("abort", userAbortHandler);
      
      // Track first token state
      const proxyState: ProxyState = {
        firstTokenEmitted: false,
        onFirstToken: () => clearTimeout(timeoutId)
      };
      
      // Create merged options with our abort signal
      const mergedOptions: SimpleStreamOptions = {
        ...options,
        signal: abortController.signal
      };
      
      try {
        // Call the built-in streamSimple
        const stream = await builtinStreamSimple!(candidate, context, mergedOptions);
        
        // Wrap to detect first token
        const wrappedStream = wrapStreamWithFirstTokenDetection(stream, proxyState);
        
        // If primary succeeded and emitted first token, forward the stream directly
        if (isPrimary && proxyState.firstTokenEmitted) {
          clearTimeout(timeoutId);
          userSignal?.removeEventListener("abort", userAbortHandler);
          
          // Forward all events from wrapped stream to result stream
          try {
            for await (const event of wrappedStream) {
              resultStream.push(event);
            }
            const finalResult = await wrappedStream.result();
            resultStream.end(finalResult);
            return;
          } catch (error) {
            // Stream errored - if we already emitted tokens, don't failover
            if (proxyState.firstTokenEmitted) {
              if (error && typeof error === "object" && "stopReason" in error) {
                resultStream.end(error as any);
              } else {
                resultStream.end({
                  role: "assistant",
                  content: [],
                  api: "openai-completions" as Api,
                  stopReason: "error",
                  errorMessage: error instanceof Error ? error.message : String(error),
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
                } as any);
              }
              return;
            }
            // No tokens yet - fall through to failover logic
          }
        }
        
        // For fallback candidates or primary without tokens yet
        // Consume the wrapped stream
        try {
          for await (const event of wrappedStream) {
            resultStream.push(event);
          }
          const finalResult = await wrappedStream.result();
          
          clearTimeout(timeoutId);
          userSignal?.removeEventListener("abort", userAbortHandler);
          
          if (!isPrimary) {
            // Calculate latency saved (how much faster fallback was vs primary timeout)
            const primaryLatencyMs = Date.now() - primaryStartTime;
            const fallbackLatencyMs = Date.now() - (attemptStartTimes.get(i) || Date.now());
            const latencySaved = Math.max(0, fallbackConfig.timeoutMs - fallbackLatencyMs);
            
            providerMetrics!.switches++;
            providerMetrics!.latencySavedMs += latencySaved;
            providerMetrics!.lastSwitch = {
              from: `${primaryModel.provider}/${primaryModel.id}`,
              to: `${candidate.provider}/${candidate.id}`,
              reason: "failover",
              timestamp: Date.now(),
              primaryLatencyMs,
            };
            
            if (fallbackConfig.notifyOnSwitch && currentContext) {
              currentContext.ui.setStatus("failover", `⚠ failover: ${primaryModel.provider}/${primaryModel.id} → ${candidate.provider}/${candidate.id}`);
              currentContext.ui.notify(`Model switched to ${candidate.provider}/${candidate.id}`, "info");
            }
            console.log(`[pi-failover] Switched to fallback: ${candidate.provider}/${candidate.id}`);
          }
          
          resultStream.end(finalResult);
          return;
        } catch (error) {
          // Fallback stream errored
          clearTimeout(timeoutId);
          userSignal?.removeEventListener("abort", userAbortHandler);
          
          // If we already emitted tokens from this fallback, don't try next
          if (proxyState.firstTokenEmitted) {
            if (error && typeof error === "object" && "stopReason" in error) {
              resultStream.end(error as any);
            } else {
              resultStream.end({
                role: "assistant",
                content: [],
                api: "openai-completions" as Api,
                stopReason: "error",
                errorMessage: error instanceof Error ? error.message : String(error),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
              } as any);
            }
            return;
          }
          
          // No tokens from this fallback, try next candidate
          lastError = error;
          
          // Check if we should failover to next candidate
          if (shouldFailover(error, proxyState, fallbackConfig)) {
            if (fallbackConfig.notifyOnSwitch && !isPrimary && currentContext) {
              currentContext.ui.setStatus("failover", `⚠ failover: ${primaryModel.provider}/${primaryModel.id} → ${candidate.provider}/${candidate.id} (failed, trying next)`);
            }
            console.log(`[pi-failover] Candidate ${i} (${candidate.provider}/${candidate.id}) failed:`, error);
            continue; // Try next fallback
          }
          
          // Non-failover error - rethrow by ending result stream with error
          if (error && typeof error === "object" && "stopReason" in error) {
            resultStream.end(error as any);
          } else {
            resultStream.end({
              role: "assistant",
              content: [],
              api: "openai-completions" as Api,
              stopReason: "error",
              errorMessage: error instanceof Error ? error.message : String(error),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
            } as any);
          }
          return;
        }
        
      } catch (error) {
        clearTimeout(timeoutId);
        userSignal?.removeEventListener("abort", userAbortHandler);
        lastError = error;
        
        // Check if we should failover to next candidate
        if (shouldFailover(error, proxyState, fallbackConfig)) {
          if (fallbackConfig.notifyOnSwitch && !isPrimary && currentContext) {
            currentContext.ui.setStatus("failover", `⚠ failover: ${primaryModel.provider}/${primaryModel.id} → ${candidate.provider}/${candidate.id} (failed, trying next)`);
          }
          console.log(`[pi-failover] Candidate ${i} (${candidate.provider}/${candidate.id}) failed:`, error);
          continue; // Try next fallback
        }
        
        // Non-failover error - end result stream with error
        if (error && typeof error === "object" && "stopReason" in error) {
          resultStream.end(error as any);
        } else {
          resultStream.end({
            role: "assistant",
            content: [],
            api: "openai-completions" as Api,
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
          } as any);
        }
        return;
      }
    }
    
    // All candidates exhausted
    if (fallbackConfig.notifyOnSwitch && currentContext) {
      currentContext.ui.setStatus("failover", `✗ all fallbacks exhausted`);
      currentContext.ui.notify("All fallback models failed", "error");
    }
    
    // End with the last error
    if (lastError && typeof lastError === "object" && "stopReason" in lastError) {
      resultStream.end(lastError as any);
    } else {
      resultStream.end({
        role: "assistant",
        content: [],
        api: "openai-completions" as Api,
        stopReason: "error",
        errorMessage: lastError instanceof Error ? lastError.message : String(lastError || "All fallbacks failed"),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      } as any);
    }
  })();
  
  return resultStream;
}

// ============================================================================
// Config Helper
// ============================================================================

function normalizeConfig(input: FallbackConfigInput | undefined): FallbackConfig {
  if (!input || !input.chain?.length) {
    return { ...DEFAULT_FALLBACK_CONFIG, chain: [] };
  }
  return {
    chain: input.chain,
    timeoutMs: input.timeoutMs ?? DEFAULT_FALLBACK_CONFIG.timeoutMs,
    onlyPreFirstToken: input.onlyPreFirstToken ?? DEFAULT_FALLBACK_CONFIG.onlyPreFirstToken,
    notifyOnSwitch: input.notifyOnSwitch ?? DEFAULT_FALLBACK_CONFIG.notifyOnSwitch,
  };
}

// ============================================================================
// Main Extension Factory
// ============================================================================

export default async function(pi: ExtensionAPI) {
  // Get the built-in streamSimple from compat
  const { streamSimple } = await import("@earendil-works/pi-ai/compat");
  builtinStreamSimple = streamSimple;
  
  // Hook into session_start to get context and register provider for ALL providers with fallback config
  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    
    // Check all registered providers for fallback config
    const providers = ctx.modelRegistry.getRegisteredProviderIds?.() ?? [];
    
    for (const providerName of providers) {
      const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(providerName) as (ProviderConfig & { fallback?: FallbackConfigInput }) | undefined;
      const rawConfig = providerConfig?.fallback;
      
      if (!rawConfig || !rawConfig.chain?.length) {
        continue; // No fallback configured for this provider
      }
      
      const config = normalizeConfig(rawConfig);
      
      // Resolve fallback models
      const fallbackModels = resolveFallbackChain(ctx.modelRegistry, config);
      
      if (!fallbackModels.length) {
        console.warn(`[pi-failover] No valid fallback models resolved for provider: ${providerName}`);
        continue;
      }
      
      // Store per-provider state
      providerStates.set(providerName, { config, models: fallbackModels });
      
      // Initialize metrics
      metrics.set(providerName, { switches: 0, latencySavedMs: 0 });
      
      console.log(`[pi-failover] Registered for provider '${providerName}' with ${fallbackModels.length} fallback(s):`, 
        fallbackModels.map(m => `${m.provider}/${m.id}`).join(", "));
      
      // Register our wrapper as the provider's streamSimple
      pi.registerProvider(providerName, {
        ...providerConfig,
        streamSimple: failoverStreamSimple
      } as ProviderConfig);
    }
  });
  
  // Clean up on session end
  pi.on("session_shutdown", () => {
    currentContext = null;
    providerStates.clear();
    metrics.clear();
  });
}
