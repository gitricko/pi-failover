# pi-failover

> True Hermes-style request-time model failover for [Pi](https://github.com/earendil-works/pi) — transparently drop to a fallback provider/model when the primary times out or errors, before Pi exhausts its own retries.

`pi-failover` is a Pi extension that wraps the primary model's `streamSimple` and, on a pre-first-token failure (timeout, connection error, 5xx, or non-retryable error), re-issues the **exact same request** (`Context` + options) against a configured fallback chain. The agent loop is unaware a switch happened.

This is **not** a post-run recovery tool. It is a transport-level, request-time failover — the same behavior Hermes provides — implemented entirely client-side, with no external gateway required.

> Status: pre-release / design-locked. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, the comparison with existing approaches, and the proof strategy.

## The problem

Pi's built-in retry handles transient errors (429, 5xx) with exponential backoff, but when a provider **hangs** (no first token) or returns a **non-retryable** error, the agent either stalls or stops. You have to manually switch models.

Existing community tools only recover *after* the run ends:

- [`cad0p/pi-fallback-provider`](https://github.com/cad0p/pi-fallback-provider) hooks `agent_end` + a 20s progress timer, then `setModel` + sends `"continue"`. Useful as a safety net, but it is **post-run**, not request-time, and cannot preserve the in-flight request.

`pi-failover` closes that gap: it fails over **inside the stream call**, before any user-visible stall.

## How it works (summary)

```
Pi agent loop → streamSimple(primaryModel, ctx, opts)
                         │
              ┌──────────▼───────────┐
              │  pi-failover wrapper  │
              │  arm AbortController  │
              │   (timeoutMs)         │
              └──────────┬───────────┘
             primary fails (pre-first-token)?
                ├── no  → pass primary stream through untouched
                └── yes → re-run builtin streamSimple(fallbackModel, ctx, opts)
                         └── same ctx, same options, same code path Pi uses
```

Key properties:

- **Same `Context`.** The fallback reuses Pi's own `streamSimple` with the verbatim `Context`/`options`. Tool definitions, history, and thinking level are identical.
- **Pre-first-token only.** Once the primary emits any token, the stream is passed through untouched — so a fallback never causes duplicate tool calls or partial-duplicate output.
- **Reuses Pi's error classification.** We import `isRetryableAssistantError` / `isContextOverflow` from `@earendil-works/pi-ai/compat`, so we fail over on the *same* conditions Pi would treat as terminal, and let Pi retry on the *same* conditions it would retry.
- **Gateway-free.** No OpenRouter/Vercel routing required.

## Install

```bash
pi install git:github.com/<you>/pi-failover@main
# or, once published:
pi install npm:@<you>/pi-failover
```

## Configuration

Add a `fallback` block to a provider in `~/.pi/agent/models.json`:

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
| `chain` | `[]` | Ordered fallback model IDs (`"provider/id"`). Tried in order, each via Pi's built-in `streamSimple`. |
| `timeoutMs` | `30000` | Per-request connect/first-token timeout. Should be shorter than Pi's whole-retry budget so a hung primary drops fast. |
| `onlyPreFirstToken` | `true` | If `false`, switches even after tokens (unsafe — may duplicate tool calls). Keep `true`. |
| `notifyOnSwitch` | `true` | Show a status bar notice on each switch. |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete algorithm, the `Context`/`streamSimple` contract, and the verification strategy that proves behavioral equivalence with Hermes.

## Verification / "is this really Hermes?"

We prove equivalence three ways (see `test/`):

1. **Structural** — assert the fallback calls Pi's own `model-runtime.streamSimple(fallbackModel, sameCtx, sameOpts)` by reference. No custom HTTP/serialization.
2. **Differential** — run the same task against our extension and a reference Hermes controller; assert byte-identical token/tool/final-output streams and `ctx === ctx'`.
3. **Fault-injection matrix** — primary timeout / 500 / 429 / partial-then-die / all-fail, each asserting the exact same observable (`stopReason`, `errorMessage`, token count, tool calls) as a Hermes reference.

## License

MIT
