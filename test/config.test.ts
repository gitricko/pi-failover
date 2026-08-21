/**
 * Tests for pi-failover extension
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadFallbackConfigForProvider, parseFallbackConfig, DEFAULT_FALLBACK_CONFIG } from "../src/config.js";

describe("pi-failover config", () => {
  describe("DEFAULT_FALLBACK_CONFIG", () => {
    it("has correct defaults", () => {
      expect(DEFAULT_FALLBACK_CONFIG.chain).toEqual([]);
      expect(DEFAULT_FALLBACK_CONFIG.timeoutMs).toBe(30000);
      expect(DEFAULT_FALLBACK_CONFIG.onlyPreFirstToken).toBe(true);
      expect(DEFAULT_FALLBACK_CONFIG.notifyOnSwitch).toBe(true);
    });
  });

  describe("parseFallbackConfig", () => {
    it("returns defaults when no fallback config", () => {
      const result = parseFallbackConfig({});
      expect(result).toEqual(DEFAULT_FALLBACK_CONFIG);
    });

    it("merges custom chain", () => {
      const result = parseFallbackConfig({
        fallback: { chain: ["openrouter/claude", "openai/gpt-4"] }
      });
      expect(result.chain).toEqual(["openrouter/claude", "openai/gpt-4"]);
    });

    it("merges custom timeoutMs", () => {
      const result = parseFallbackConfig({ fallback: { timeoutMs: 15000 } });
      expect(result.timeoutMs).toBe(15000);
    });

    it("merges onlyPreFirstToken", () => {
      const result = parseFallbackConfig({ fallback: { onlyPreFirstToken: false } });
      expect(result.onlyPreFirstToken).toBe(false);
    });

    it("merges notifyOnSwitch", () => {
      const result = parseFallbackConfig({ fallback: { notifyOnSwitch: false } });
      expect(result.notifyOnSwitch).toBe(false);
    });
  });

  describe("loadFallbackConfigForProvider", () => {
    it("returns defaults when provider not found", () => {
      const mockRegistry = {
        getRegisteredProviderConfig: vi.fn().mockReturnValue(undefined)
      };
      const result = loadFallbackConfigForProvider("anthropic", mockRegistry);
      expect(result).toEqual(DEFAULT_FALLBACK_CONFIG);
    });

    it("parses fallback config from provider", () => {
      const mockRegistry = {
        getRegisteredProviderConfig: vi.fn().mockReturnValue({
          fallback: { chain: ["openrouter/claude"], timeoutMs: 20000 }
        })
      };
      const result = loadFallbackConfigForProvider("anthropic", mockRegistry);
      expect(result.chain).toEqual(["openrouter/claude"]);
      expect(result.timeoutMs).toBe(20000);
    });
  });
});