# pi-failover

> True Hermes-style request-time model failover for [Pi](https://github.com/earendil-works/pi) — transparently drop to a fallback provider/model when the primary times out or errors, before Pi exhausts its own retries.

`pi-failover` is a Pi extension that wraps the primary model's `streamSimple` and, on a pre-first-token failure (timeout, connection error, 5xx, or non-retryable error), re-issues the **exact same request** (`Context` + options) against a configured fallback chain. The agent loop is unaware a switch happened.

This is **not** a post-run recovery tool. It is a transport-level, request-time failover — the same behavior Hermes provides — implemented entirely client-side, with no external gateway required.

> Status: pre-release / design-locked. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, the comparison with existing approaches, and the proof strategy.

---

## The problem

Pi's built-in retry handles transient errors (429, 5xx) with exponential backoff, but when a provider **hangs** (no first token) or returns a **non-retryable** error, the agent either stalls or stops. You have to manually switch models.

Existing community tools only recover *after* the run ends:

- [`cad0p/pi-fallback-provider`](https://github.com/cad0p/pi-fallback-provider) hooks `agent_end` + a 20s progress timer, then `setModel` + sends `"continue"`. Useful as a safety net, but it is **post-run**, not request-time, and cannot preserve the in-flight request.

`pi-failover` closes that gap: it fails over **inside the stream call**, before any user-visible stall.

---

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
- **Reuses Pi's error classification.** We import `isRetryableAssistantError` / `isContextOverflow` from `@earendil-works/pi-ai`, so we fail over on the *same* conditions Pi would treat as terminal, and let Pi retry on the *same* conditions it would retry.
- **Gateway-free.** No OpenRouter/Vercel routing required.

---

## Install

```bash
# From local source (development)
pi install . --local --approve

# From Git (once published)
pi install git:github.com/gitricko/pi-failover@main

# From npm (once published)
pi install npm:@gitricko/pi-failover
```

---

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

---

## Development

### Prerequisites

- Node.js ≥ 22.19.0
- Pi CLI (`@earendil-works/pi-coding-agent`) 0.84.2+

### Install dependencies

```bash
npm ci
```

### Build

```bash
npm run build
```

Outputs to `dist/`:
- `index.js` / `index.d.ts` — main extension entry point
- `config.js` / `config.d.ts` — configuration types & loader

### Test

```bash
# Run all tests (25 tests)
npx vitest run

# Run with verbose output
npx vitest run --reporter=verbose

# Watch mode
npx vitest
```

**Test coverage (25 tests):**

| Suite | Tests | Coverage |
|-------|-------|----------|
| Config loading | 8 | Defaults, parse/merge, registry loading |
| Error classification (`shouldFailover`) | 6 | AbortError, network errors, timeout, 429 (retryable), 400 (non-retryable), context overflow |
| First-token detection (`proxyFirstToken`) | 4 | `text_delta`, `thinking_start`, `toolcall_start`, error-after-token |
| Fallback chain (`createFailoverWrapper`) | 2 | No-fallback passthrough, timeout→fallback switch |
| Config integration | 2 | Chain parsing, registry loading |

### Type check

```bash
npx tsc -p tsconfig.json --noEmit
```

### Lint (if configured)

```bash
npx eslint src/ test/
```

### Full local verification (matches CI)

```bash
npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

---

## CI / GitHub Actions

The project includes a CI workflow at `.github/workflows/ci.yml` with three jobs:

| Job | Runs | Description |
|-----|------|-------------|
| `lint` | Every push/PR | TypeScript `--noEmit`, ESLint (if configured) |
| `test` | Every push/PR | `vitest run --reporter=verbose` (25 tests) |
| `build` | After lint+test pass | `npm run build`, verifies `dist/` output |
| `integration` | Manual (disabled) | Optional Pi CLI integration test |

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for:

- Problem statement & comparison table
- Architecture diagram (ASCII)
- Core algorithm (pseudocode)
- Configuration schema
- **Proof of equivalence with Hermes** (4 methods):
  - (A) Structural — same code path by reference
  - (B) Differential — byte-identical token/tool/final streams
  - (C) Fault-injection matrix — 5 scenarios
  - (D) Observability — status lines & counters
- Risks & mitigations
- Comparison with `cad0p/pi-fallback-provider`
- Build plan

---

## License

MIT