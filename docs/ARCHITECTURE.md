# Architecture — `pi-failover`

This document is the **design record** for the `pi-failover` extension: a true
Hermes-style, request-time model failover for Pi. It captures the problem
statement, the architecture diagram, the algorithm, the Pi API contract it
relies on (verified against the installed `pi-coding-agent` 0.84.2 build), and
the strategy used to *prove* behavioral equivalence with Hermes.

---

## 1. Problem statement

**Hermes-style fallback** is defined as: at request time, transparently, when a
primary model/provider fails to produce a usable response (timeout before first
token, connection error, 5xx, or non-retryable 4xx), the harness **re-issues the
same request against a secondary provider/model** with no user interaction, and
the rest of the agent loop is unaware.

The defining properties:

1. **Request-time**, not post-run. The switch happens *inside* the stream call.
2. **Preserves the exact same prompt/context/tool state** — the `Context`.
3. **Pre-first-token only** — switching after tokens would duplicate side effects.

### Why existing approaches are not enough

| Approach | Request-time? | Same context? | Pre-first-token safe? | Needs gateway? |
|---|---|---|---|---|
| `cad0p/pi-fallback-provider` | ❌ post-run (`agent_end` + 20s timer) | ✅ (`"continue"`) | n/a | ❌ |
| OpenRouter `allow_fallbacks` | ✅ (provider-side) | ✅ | ✅ | ✅ (gateway) |
| `pi-failover` (this) | ✅ (client-side) | ✅ (same `ctx`) | ✅ | ❌ |

`cad0p/pi-fallback-provider` hooks `agent_end` after Pi's retries are exhausted
and calls `pi.setModel(...)` + `pi.sendUserMessage("continue")`. It is a good
**safety net** but (a) it cannot preserve the in-flight request, (b) it requires
`enabledModels` to be set or it does nothing, and (c) it reacts seconds after the
failure. `pi-failover` is the only option that is both request-time *and*
gateway-free — the literal Hermes behavior.

---

## 2. Feasibility in the current Pi build (verified)

From the installed `pi-coding-agent` 0.84.2 source:

- `provider-composer.js:310-311` — when an extension registers `streamSimple`,
  the agent loop calls **the extension's** `streamSimple` instead of the
  built-in one:
  ```js
  if (extension?.streamSimple && model.api === extension.api) {
      return extension.streamSimple(model, context, options);
  }
  ```
- `model-runtime.js:461-468` — the real call path is
  `streamSimple(model, context, options)`; `Context` carries everything
  (messages, tools, thinking level, abort signal).
- `@earendil-works/pi-ai/compat` already exports `isRetryableAssistantError`,
  `isRecoverableLength`, `isContextOverflow` — the exact classification logic we
  reuse so we never fight Pi's own retries.

Therefore the injection point (`pi.registerProvider(id, { streamSimple })`) is
**first-class and legitimate**. No Pi core patches are required.

---

## 3. Architecture diagram

```
                         ┌─────────────────────────────────────────────┐
                         │            Pi Agent Loop                     │
                         │  (calls agent.streamFunction = streamSimple) │
                         └───────────────────────┬─────────────────────┘
                                                 │  streamSimple(primaryModel, ctx, opts)
                                                 ▼
                         ┌─────────────────────────────────────────────┐
                         │   pi-failover Extension (wrapper)            │
                         │                                              │
      registerProvider   │   fallback.streamSimple(model, ctx, opts):   │
      ("anthropic",      │    1. arm AbortController(timeout) + sig     │
       streamSimple)  ──▶│    2. attempt PRIMARY stream                 │
                         │           │                                  │
                         │           ▼                                  │
                         │     ┌───────────────────────────┐           │
                         │     │ PRIMARY attempt            │           │
                         │     │ - wrap result() in a Proxy │           │
                         │     │ - detect first-token       │           │
                         │     │ - catch timeout/throw      │           │
                         │     └───────┬───────────┬───────┘           │
                         │             │           │                   │
                         │    tokens   │           │  FAIL before      │
                         │    emitted? │           │  first token:     │
                         │             ▼           │  timeout /        │
                         │        [PASS]          │  error / 5xx /     │
                         │        stream          │  non-retryable    │
                         │        through         ▼                   │
                         │                        │                   │
                         │              ┌─────────┴──────────┐        │
                         │              │ map ctx+opts to     │        │
                         │              │ FALLBACK model id   │        │
                         │              │ (same Context!)     │        │
                         │              └─────────┬──────────┘        │
                         │                        │                   │
                         │                        ▼                   │
                         │              ┌──────────────────────┐      │
                         │              │ FALLBACK attempts     │      │
                         │              │ (chain: f1, f2, ...)  │      │
                         │              │ each via built-in    │      │
                         │              │ streamSimple(model')  │      │
                         │              └──────────┬───────────┘      │
                         │                         │                  │
                         │            all failed?  │  one succeeded?  │
                         │                 ┌───────┴────────┐         │
                         │                 ▼                ▼          │
                         │           [re-throw error]   [stream the   │
                         │           (Pi retries /      fallback's     │
                         │            agent_end)]     output as if     │
                         │                              primary]        │
                         └─────────────────────────────────────────────┘
                                                 │
                 same Context reused ────────────┤
                                                 ▼
                         ┌─────────────────────────────────────────────┐
                         │  Built-in Pi streamSimple (per provider)     │
                         │  model-runtime.getAuth(model) → creds        │
                         │  (primary & fallback each resolve own key)   │
                         └─────────────────────────────────────────────┘

   Config: models.json → "fallback": { "chain": [...], "timeoutMs": 30000,
                                       "onlyPreFirstToken": true }
```

The wrapper is registered **over the primary provider**. It reuses Pi's own
`streamSimple` for each candidate, so auth, thinking params, prompt caching, and
tool serialization are identical to a normal call. **The fallback path is the
same code Pi would run anyway** — just for a different `model`.

---

## 4. Core algorithm (pseudo)

```ts
fallbackStreamSimple(primaryModel, ctx, opts):
  candidates = [primaryModel, ...resolveFallbackChain(primaryModel)]
  for i, model in candidates:
    ac = new AbortController()
    timer = setTimeout(() => ac.abort(), timeoutMs)
    // thread user ESC / ctx abort into our controller
    ctx.signal?.addEventListener("abort", () => ac.abort())
    try:
      stream = builtinStreamSimple(model, ctx, opts)   // SAME ctx
      return proxyFirstToken(stream, onFirstToken = () => clearTimeout(timer))
    catch err:
      if (err is abort from our timer):            // primary hung
        log switch i -> i+1; continue
      if (err is networkError):                    // connection failed
        log switch i -> i+1; continue
      if (!isRetryableAssistantError(err)):         // non-retryable 4xx/5xx
        log switch i -> i+1; continue
      // retryable: let Pi handle it, re-throw
      throw err
  throw lastError   // Pi retries / agent_end as normal
```

**Critical invariants**

- **Same `Context`.** We never rebuild the prompt. `ctx` and `opts` are passed
  verbatim to each candidate. Tool definitions, history, thinking level identical.
- **Pre-first-token only.** Once any token is yielded from the primary, we return
  that stream untouched. A fallback never interrupts a partially generated
  response → no duplicate tool calls.
- **Reuse Pi's error classes.** Import `isRetryableAssistantError` /
  `isContextOverflow` from `@earendil-works/pi-ai/compat`, so we fail over on the
  *same* conditions Pi would classify as terminal, and let Pi retry on the *same*
  conditions it would retry.
- **Timeout is orthogonal to Pi's retries.** The per-request first-token timeout
  (default 30s) is shorter than Pi's whole-retry budget (3 × exp backoff ≈ 14s of
  *retry*, but a true hang has no retry). A hung primary drops to fallback fast;
  Pi's backoff still applies to each fallback candidate.

---

## 5. Configuration schema (declarative)

`~/.pi/agent/models.json`:

```jsonc
{
  "providers": {
    "anthropic": {
      "fallback": {
        "chain": ["openrouter/anthropic/claude-...", "openai/gpt-5"],
        "timeoutMs": 30000,
        "onlyPreFirstToken": true,
        "notifyOnSwitch": true
      }
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `chain` | `[]` | Ordered fallback model IDs (`"provider/id"`). |
| `timeoutMs` | `30000` | Per-request connect/first-token timeout. |
| `onlyPreFirstToken` | `true` | Keep `true`; switching after tokens is unsafe. |
| `notifyOnSwitch` | `true` | Status bar notice on each switch. |

The extension reads this on load, registers a `streamSimple` wrapper over the
primary provider, and resolves chain models via `ctx.modelRegistry.find(...)`.

---

## 6. Proof of equivalence with Hermes

We assert `pi-failover` behaves **exactly** like a textbook Hermes controller
through four independent methods.

### (A) Structural equivalence — "same code path" proof

Monkeypatch `model-runtime.streamSimple`, force the primary to time out, and
assert the fallback call is `model-runtime.streamSimple(fallbackModel, sameCtx,
sameOpts)` **by reference**. Differences are impossible unless our wrapper
alters `ctx`/`opts` — so we additionally assert `ctx === ctx'` and `opts === opts'`.
No custom HTTP, no custom serialization.

### (B) Differential test against a reference Hermes

Build a reference "ideal" router in the test harness:

- Primary always times out at t = 31s; fallback responds at t = 2s.

Run the **same** agent task against (i) `pi-failover` and (ii) a hand-rolled
controller that does the textbook Hermes switch. Assert the emitted token stream,
tool-call sequence, and final answer are **byte-identical** (both use the same
fallback model via the same `streamSimple`).

### (C) Fault-injection matrix

| Scenario | Hermes expected | `pi-failover` | Match |
|---|---|---|---|
| Primary timeout, fallback OK | switch | switch | ✅ |
| Primary 500, fallback OK | switch | switch | ✅ |
| Primary 429 (retryable) | Pi retries, no switch | Pi retries, no switch | ✅ (reuse `isRetryableAssistantError`) |
| Primary emits 1 token then dies | no switch (partial) | no switch (proxy passed through) | ✅ |
| All candidates fail | error → agent_end | error → agent_end (same error shape) | ✅ |

Each row asserts the **exact same observable** (`stopReason`, `errorMessage`,
token count, tool calls) as a Hermes reference for that row.

### (D) Observability proof

Emit a status line `⚠ failover: anthropic→openrouter (timeout 31000ms)` and
counters `failover.switches` / `failover.latencySaved`, so in production you can
confirm a switch happened **without** a user action and **before** Pi's retry
budget — the defining Hermes behavior.

---

## 7. Risks & mitigations

- **Stream-proxy complexity** — wrapping `AssistantMessageEventStream` must
  faithfully forward all event types (text deltas, `tool_use`, thinking, finish)
  without buffering. Mitigation: proxy by reference, never collect.
- **Per-request, not per-turn** — fallback is per *request*, so a later
  successful tool call is never re-routed. Mitigation: decision scope is the
  `streamSimple` call only.
- **Idempotency** — guaranteed by pre-first-token switching; partial generation
  side effects are impossible.
- **AbortSignal propagation** — must thread `ctx`'s abort signal into the
  timeout `AbortController` so user ESC still cancels. Mitigation: forward
  `ctx.signal` abort → controller abort.

---

## 8. Comparison with the `cad0p/pi-fallback-provider` review

Findings from the code review (kept for context):

1. With default config (no `enabledModels`) it does **nothing**.
2. No access to Pi's internal `willRetry` flag (stripped at `agent-session.js:446`);
   uses a hard-coded 20s heuristic.
3. Dead TUI probe code (`setWidget` then immediately `undefined`); `tuiRef` unused.
4. `onTerminalInput` listener leaks across `session_start`.
5. `package.json` declares no peer deps.

`pi-failover` deliberately avoids all of these: request-time hook, no required
config to be safe (empty chain = pass-through), no TUI probe, no leaked
listeners, explicit peer deps on `pi-coding-agent`/`pi-tui`.

---

## 9. Build plan (incremental)

1. `index.ts` — `registerProvider` + `streamSimple` wrapper skeleton + config loader.
2. `test/` — fault-injection harness proving §6(A)/(C).
3. Config schema + observability (§5/(D)).
4. Package metadata for `pi install` + publish.
