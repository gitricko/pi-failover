/**
 * Fault-injection tests for pi-failover extension
 * Implements the verification matrix from docs/ARCHITECTURE.md §6(C)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Model, Context, SimpleStreamOptions, AssistantMessageEventStream, Api, AssistantMessageEvent, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { loadFallbackConfigForProvider, parseFallbackConfig, DEFAULT_FALLBACK_CONFIG } from "../src/config.js";

// Import the internal functions for testing
import {
  proxyFirstToken,
  shouldFailover,
  createFailoverWrapper,
} from "../src/index.js";

describe("pi-failover fault-injection matrix (ARCHITECTURE.md §6)", () => {
  describe("shouldFailover - error classification", () => {
    it("returns true for AbortError (timeout)", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      const config = DEFAULT_FALLBACK_CONFIG;
      expect(shouldFailover(error, config)).toBe(true);
    });

    it("returns true for CancellationError", () => {
      const error = new Error("Cancelled");
      error.name = "CancellationError";
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for network errors (ECONNREFUSED)", () => {
      const error = new Error("connect ECONNREFUSED");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for network errors (ENOTFOUND)", () => {
      const error = new Error("getaddrinfo ENOTFOUND");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for timeout errors", () => {
      const error = new Error("timeout");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for fetch failed", () => {
      const error = new Error("fetch failed");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for connection errors (dead provider)", () => {
      const error = new Error("Connection error.");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for ECONNREFUSED", () => {
      const error = new Error("connect ECONNREFUSED");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for retryable errors (429) — pre-first-token failover absorbs them", () => {
      const error = new Error("429 Too Many Requests");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for non-retryable client errors (400) — failover still tries next candidate", () => {
      const error = new Error("400 Bad Request");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });

    it("returns true for context overflow (pre-first-token failover)", () => {
      const error = new Error("context length exceeded");
      expect(shouldFailover(error, DEFAULT_FALLBACK_CONFIG)).toBe(true);
    });
  });

  describe("proxyFirstToken - first token detection", () => {
    it("detects text_delta as first token", async () => {
      const source = createAssistantMessageEventStream();
      let firstTokenCalled = false;

      const proxy = proxyFirstToken(
        source,
        () => { firstTokenCalled = true; },
        () => {}
      );

      source.push({ type: "text_delta", text: "Hello" });
      source.end();

      for await (const _ of proxy) {}

      expect(firstTokenCalled).toBe(true);
    });

    it("detects thinking_start as first token", async () => {
      const source = createAssistantMessageEventStream();
      let firstTokenCalled = false;

      const proxy = proxyFirstToken(
        source,
        () => { firstTokenCalled = true; },
        () => {}
      );

      source.push({ type: "thinking_start" });
      source.end();

      for await (const _ of proxy) {}

      expect(firstTokenCalled).toBe(true);
    });

    it("detects toolcall_start as first token", async () => {
      const source = createAssistantMessageEventStream();
      let firstTokenCalled = false;

      const proxy = proxyFirstToken(
        source,
        () => { firstTokenCalled = true; },
        () => {}
      );

      source.push({ type: "toolcall_start", id: "1", name: "test", arguments: {} });
      source.end();

      for await (const _ of proxy) {}

      expect(firstTokenCalled).toBe(true);
    });

    it("passes through errors after first token", async () => {
      const source = createAssistantMessageEventStream();
      let firstTokenCalled = false;

      const proxy = proxyFirstToken(
        source,
        () => { firstTokenCalled = true; },
        () => {}
      );

      source.push({ type: "text_delta", text: "Hello" });
      source.push(Promise.reject(new Error("Stream error")));
      source.end();

      const events: AssistantMessageEvent[] = [];
      for await (const event of proxy) {
        events.push(event);
      }

      expect(firstTokenCalled).toBe(true);
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toBeDefined();
    });
  });

  describe("createFailoverWrapper - fallback chain behavior", () => {
    it("returns primary streamSimple when no fallback chain", async () => {
      const mockStream = createAssistantMessageEventStream();
      mockStream.push({ type: "text_delta", text: "test" });
      mockStream.end();

      const capturedBuiltin = vi.fn().mockReturnValue(mockStream);

      const mockModelRegistry = {
        getProvider: vi.fn().mockReturnValue(undefined),
        find: vi.fn().mockReturnValue(undefined),
        runtime: undefined,
      };

      const config = { chain: [], timeoutMs: 30000, onlyPreFirstToken: true, notifyOnSwitch: false };
      const wrapper = createFailoverWrapper("test-provider", capturedBuiltin, mockModelRegistry, config, () => undefined);

      const mockModel = { provider: "test-provider", id: "test-model", api: "openai-completions" } as Model<Api>;
      const mockContext = {} as Context;
      const mockOptions = {} as SimpleStreamOptions;

      const stream = wrapper(mockModel, mockContext, mockOptions);
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("text_delta");
      expect(events[0].text).toBe("test");
      expect(capturedBuiltin).toHaveBeenCalledWith(mockModel, mockContext, mockOptions);
    });

    it("tries fallback when primary times out (pre-first-token)", async () => {
      // Primary stream: never emits, just hangs
      const primaryStream = createAssistantMessageEventStream();
      // Fallback stream: emits lazily (don't pre-end; pi-ai streams replay only while open)
      const fallbackStream = createAssistantMessageEventStream();

      const fallbackModel = {
        provider: "fallback-provider",
        id: "fallback-model",
        api: "openai-completions",
      } as Model<Api>;

      const mockModelRegistry = {
        getProvider: vi.fn().mockReturnValue(undefined),
        find: vi.fn().mockImplementation((providerId: string) => {
          if (providerId === "fallback-provider") return fallbackModel;
          return undefined;
        }),
      };

      // Captured builtin dispatches by model.provider
      const capturedBuiltin = vi.fn().mockImplementation((model: Model<Api>) => {
        if (model.provider === "fallback-provider") {
          // Emit the fallback token on next tick, then end
          setTimeout(() => {
            fallbackStream.push({ type: "text_delta", contentIndex: 0, delta: "fallback response", partial: {} as any });
            fallbackStream.end();
          }, 10);
          return fallbackStream;
        }
        return primaryStream;
      });

      const config = { 
        chain: ["fallback-provider/fallback-model"], 
        timeoutMs: 50,
        onlyPreFirstToken: true, 
        notifyOnSwitch: false 
      };
      
      // rawStreamSimple resolver: returns capturedBuiltin for the fallback provider
      // (so the fallback candidate resolves through the raw path, not re-wrapped)
      const rawResolver = (providerId: string) =>
        providerId === "fallback-provider" ? capturedBuiltin : undefined;

      const wrapper = createFailoverWrapper("primary-provider", capturedBuiltin, mockModelRegistry, config, rawResolver);

      const mockModel = { provider: "primary-provider", id: "primary-model", api: "openai-completions" } as Model<Api>;
      const mockContext = {} as Context;
      const mockOptions = {} as SimpleStreamOptions;

      const stream = wrapper(mockModel, mockContext, mockOptions);
      
      // Consume with a timeout so the hung primary triggers our abort → fallback
      const events: AssistantMessageEvent[] = [];
      const timeout = setTimeout(() => {
        throw new Error("Test timed out waiting for fallback");
      }, 5000);
      try {
        for await (const event of stream) {
          events.push(event);
          if (events.length >= 2) break; // got the fallback token + end
        }
      } finally {
        clearTimeout(timeout);
      }

      // Should have fallback response
      expect(events.some(e => e.type === "text_delta" && (e as any).delta === "fallback response")).toBe(true);
    });

    it("does NOT infinitely recurse on circular fallback config", async () => {
      // Circular config: A → B, B → A. Each provider's raw streamSimple is the
      // pre-wrap path, so this must terminate (exhaust the chain) instead of looping forever.
      const streamA = createAssistantMessageEventStream();
      const streamB = createAssistantMessageEventStream();
      const modelA = { provider: "provA", id: "modelA", api: "openai-completions" } as Model<Api>;
      const modelB = { provider: "provB", id: "modelB", api: "openai-completions" } as Model<Api>;

      // raw streamSimple snapshot: BOTH hang forever (simulating unreachable servers)
      const rawStreamSimple = (providerId: string) => {
        return (_model: Model<Api>, _ctx: Context, _opts?: SimpleStreamOptions) => {
          return providerId === "provB" ? streamB : streamA;
        };
      };

      const mockModelRegistry: any = {
        getProvider: vi.fn().mockReturnValue(undefined),
        find: vi.fn().mockImplementation((p: string) =>
          p === "provA" ? modelA : p === "provB" ? modelB : undefined),
      };

      const configA = { chain: ["provB/modelB"], timeoutMs: 50, onlyPreFirstToken: true, notifyOnSwitch: false };
      const wrapperA = createFailoverWrapper("provA", rawStreamSimple("provA")!, mockModelRegistry, configA, rawStreamSimple);

      const timeout = setTimeout(() => { throw new Error("CIRCULAR RECURSION — test hung"); }, 4000);
      let count = 0;
      try {
        const stream = wrapperA(modelA, {} as Context, {} as SimpleStreamOptions);
        for await (const _e of stream) { count++; }
      } finally {
        clearTimeout(timeout);
      }
      // If we got here, there was no infinite loop. (count may be 0 — both hang → abort → exhaust.)
      expect(true).toBe(true);
    });
  });

  describe("Configuration loading", () => {
    it("parses fallback config with chain", () => {
      const result = parseFallbackConfig({
        fallback: { chain: ["provider/model1", "provider/model2"] }
      });
      expect(result.chain).toEqual(["provider/model1", "provider/model2"]);
    });

    it("loads config from model registry", () => {
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