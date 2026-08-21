/**
 * Configuration types and loader for pi-failover extension.
 * Reads fallback configuration from ~/.pi/agent/models.json
 */

import type { Model } from "@earendil-works/pi-ai";

/** Minimal ProviderConfigInput shape we need for fallback configuration. */
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: any;
  streamSimple?: (model: Model<any>, context: any, options?: any) => any;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: any;
  models?: any[];
  refreshModels?: (context: any) => Promise<any>;
}

export interface FallbackConfig {
  /** Ordered fallback model IDs ("provider/id"). Tried in order. */
  chain: string[];
  /** Per-request connect/first-token timeout in milliseconds. */
  timeoutMs: number;
  /** If true (default), only fail over before first token. If false, switches even after tokens (unsafe). */
  onlyPreFirstToken: boolean;
  /** Show status bar notice on each switch. */
  notifyOnSwitch: boolean;
}

/** Provider config with fallback extension fields. */
export interface FallbackProviderConfig extends ProviderConfigInput {
  fallback?: Partial<FallbackConfig>;
}

/** Default fallback configuration values. */
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  chain: [],
  timeoutMs: 30000,
  onlyPreFirstToken: true,
  notifyOnSwitch: true,
};

/**
 * Resolves a fallback chain model ID to a Model instance using the model registry.
 * @param modelId - Model ID in format "provider/id"
 * @param modelRegistry - Pi's model registry
 * @returns Model instance or undefined if not found
 */
export function resolveFallbackModel(
  modelId: string,
  modelRegistry: { find: (provider: string, modelId: string) => Model<any> | undefined }
): Model<any> | undefined {
  const [providerId, ...modelIdParts] = modelId.split("/");
  const fullModelId = modelIdParts.join("/");
  return modelRegistry.find(providerId, fullModelId);
}

/**
 * Parses fallback configuration from a provider's config object.
 * @param providerConfig - The provider config from models.json
 * @returns Merged fallback config with defaults
 */
export function parseFallbackConfig(providerConfig: FallbackProviderConfig): FallbackConfig {
  const fallback = providerConfig.fallback ?? {};
  return {
    chain: fallback.chain ?? DEFAULT_FALLBACK_CONFIG.chain,
    timeoutMs: fallback.timeoutMs ?? DEFAULT_FALLBACK_CONFIG.timeoutMs,
    onlyPreFirstToken: fallback.onlyPreFirstToken ?? DEFAULT_FALLBACK_CONFIG.onlyPreFirstToken,
    notifyOnSwitch: fallback.notifyOnSwitch ?? DEFAULT_FALLBACK_CONFIG.notifyOnSwitch,
  };
}

/**
 * Loads fallback configuration for a specific provider from the model registry.
 * @param providerId - Provider ID (e.g., "anthropic", "openai")
 * @param modelRegistry - Pi's model registry from ExtensionContext
 * @returns FallbackConfig with defaults applied
 */
export function loadFallbackConfigForProvider(
  providerId: string,
  modelRegistry: { getRegisteredProviderConfig: (id: string) => ProviderConfigInput | undefined }
): FallbackConfig {
  const providerConfig = modelRegistry.getRegisteredProviderConfig(providerId) as FallbackProviderConfig | undefined;
  return parseFallbackConfig(providerConfig ?? {} as FallbackProviderConfig);
}