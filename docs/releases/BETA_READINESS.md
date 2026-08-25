# Resili Beta Readiness

**Status:** Planning document. Not a commitment to a date.

**Audited against:** `main` @ `cf1f224d053cb1000541cfaa4727e7be3db3a5df`

**Working tree at audit:** clean

**Test baseline used:** 598 tests / 38 files (last validated on this line)

This document is the authoritative beta plan. Source and tests override older docs when they disagree. It does not implement, version, publish, or tag anything.

---

## Current Status

Resili is a **public alpha** with two independently versioned lines, eight published packages, nine core policies, pull-through LLM streaming, and recently consolidated documentation.

| Line        | Packages                                       | Public version  | npm `alpha`     | npm `latest` (stale) |
| ----------- | ---------------------------------------------- | --------------- | --------------- | -------------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`  | `0.2.0-alpha.3` | `0.2.0-alpha.3` | `0.1.0-alpha.1`      |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic` | `0.1.0-alpha.4` | `0.1.0-alpha.4` | `0.1.0-alpha.1`      |
|             | `@resili/llm-gemini`                           | `0.1.0-alpha.3` | `0.1.0-alpha.3` | `0.1.0-alpha.1`      |

**What is already true**

- Core wraps any async function. Zero runtime dependencies.
- Retry, timeout, circuit breaker, rate limiter, bulkhead, cache, fallback, dedupe, and hedge are implemented and unit-tested.
- HTTP adapters are thin, injected (except fetch’s global default), ESM+CJS, Node `>=20`.
- LLM `generate()` and `stream()` exist for OpenAI, Anthropic, and Gemini. Provider SDK retries are disabled.
- Streaming commit point is enforced as of `@resili/llm@0.1.0-alpha.4` (post-commit timeout does not retry).
- Public-registry verification of the current LLM alpha passed.
- Documentation covers install, policies, HTTP, LLM, providers, errors, budget, and observability.

**What is not yet true**

- Public APIs have not been through an explicit freeze review.
- HTTP adapters do expose caller-initiated per-call cancellation through the existing `signal` field.
- Core honesty items from Milestone 4 are on `main`. LLM/provider freeze is Milestone 5 (`fix/llm-beta-api-lock`). Pack CI for HTTP remains Milestone 6.
- CI runs Node 22 only. Packed-consumer, ESM/CJS, and Node 20/24 gates are manual or absent.
- HTTP adapters have no API Extractor report. LLM/provider reports are added in Milestone 5.

**Verdict in one line:** the product is capable enough to beta; the contract is not frozen enough to beta.

---

## What Beta Means

Beta does **not** mean every future feature is implemented.

Beta does **not** mean production-ready, LTS, or semver-stable `latest`.

Beta means:

1. **Public APIs are intentionally reviewed** and then treated as mostly stable. Remaining breaks are rare, documented, and justified.
2. **Core semantics are trustworthy.** Retry, timeout, cancellation, classification, and streaming commit behavior match the docs under adversarial cases.
3. **High-impact DX gaps are resolved.** A developer using the advertised call shape (especially `fetch(url, { signal })`) gets the behavior that shape implies.
4. **Install and dependency graphs are reliable.** `workspace:*` does not leak. One copy of `@resili/core` / `@resili/llm`. Dist-tags are documented and followed.
5. **Important failure-mode interactions are tested**, not only isolated policies.
6. **Supported Node versions are verified** in automation, not only declared in `engines`.
7. **Documentation is sufficient** for an external developer to install, configure, fail, cancel, stream, and observe without reading source.
8. **Release checks are repeatable** in CI, not a maintainer checklist in someone’s head.

Stable **v1.0** is a later bar: real external usage, proven API stability through beta, `latest` moved on purpose, semver policy in force.

---

## Current Package Inventory

All eight packages: `type: module`, dual `exports` (`import` / `require` / `types`), `engines.node: ">=20"`, `files: ["dist", "README.md", "LICENSE"]`, `publishConfig.access: public`.

| Package                 | Version         | Purpose                                                                | Runtime deps                   | Optional peers                | ESM/CJS | Alpha status                         |
| ----------------------- | --------------- | ---------------------------------------------------------------------- | ------------------------------ | ----------------------------- | ------- | ------------------------------------ |
| `@resili/core`          | `0.2.0-alpha.3` | Context, pipeline, 9 policies, events, metrics, errors                 | none                           | —                             | Yes     | Current core/HTTP line               |
| `@resili/fetch`         | `0.2.0-alpha.3` | fetch-compatible wrapper                                               | `@resili/core` (`workspace:*`) | —                             | Yes     | Current                              |
| `@resili/axios`         | `0.2.0-alpha.3` | axios-compatible wrapper; injected implementation                      | `@resili/core` (`workspace:*`) | none (structural; not a peer) | Yes     | Current                              |
| `@resili/undici`        | `0.2.0-alpha.3` | undici-compatible `request` wrapper; injected implementation           | `@resili/core` (`workspace:*`) | none (structural; not a peer) | Yes     | Current                              |
| `@resili/llm`           | `0.1.0-alpha.4` | Provider-neutral LLM client, usage, pricing, Budget Guard, telemetry   | `@resili/core` (`workspace:*`) | —                             | Yes     | Current LLM line                     |
| `@resili/llm-openai`    | `0.1.0-alpha.4` | Chat Completions unary + stream; `maxRetries: 0`                       | `@resili/core`, `@resili/llm`  | `openai >=4.0.0`              | Yes     | Current                              |
| `@resili/llm-anthropic` | `0.1.0-alpha.4` | Messages unary + stream; `maxRetries: 0`                               | `@resili/core`, `@resili/llm`  | `@anthropic-ai/sdk >=0.20.0`  | Yes     | Current                              |
| `@resili/llm-gemini`    | `0.1.0-alpha.3` | `@google/genai` generateContent / generateContentStream; `attempts: 1` | `@resili/core`, `@resili/llm`  | `@google/genai >=1.0.0`       | Yes     | Current for Gemini; one patch behind |

Packed publishes pin `workspace:*` to the version from the same release run. Mixing packages across runs in one line is unsupported.

---

## P0 — Beta Blockers

Must be fixed or explicitly decided before a beta tag exists.

### P0-1. HTTP caller-initiated per-call cancellation

**Classification: P0. Beta blocker: yes.**

Source: `packages/fetch/src/index.ts`, `packages/axios/src/index.ts`, `packages/undici/src/index.ts`.

**Status (Milestone 3):** Implemented on `fix/http-caller-cancellation`. Adapters pass the caller
`signal` to `client.execute(operation, { signal })`. Transport still receives composed `ctx.signal`.

**Historical bug:** All three adapters called `client.execute(operation)` **without** `ContextInit`. They overwrote `init.signal` / `config.signal` / `options.signal` with `ctx.signal`. Timeout-driven abort worked. A caller `AbortSignal` on the HTTP call did **not** abort the Resili execution.

Native `fetch` honors `init.signal`. Shipping a fetch-shaped API that silently ignores it is a high-impact DX and correctness gap, not a missing extra feature.

**Required behavior for beta (design, not implementation):**

- A caller `AbortSignal` supplied on the adapter invocation must abort **that logical Resili request**.
- Caller abort composes with timeout and other policy signals. The transport still receives the composed `ctx.signal`.
- Abort remains **not a failure** and **not retryable** (same as core `AbortError` / `name === "AbortError"`).
- Behavior is **identical** across fetch, axios, and undici.
- Docs and examples match the implemented call shape.

Do not leave “wrap with `createClient` yourself” as the only path for the primary HTTP packages.

### P0-2. Public API freeze review completed

**Classification: P0 (process). Beta blocker: yes.**

There is an API Extractor report for `@resili/core` only. Milestone 4 exported the previously forgotten Core types and unified `KeyResolver`. `@resili/llm` and the HTTP adapters have no equivalent freeze artifact.

Beta requires a written review of every public export on all eight packages, a decision per export (keep / export properly / hide), and then treating the remainder as mostly stable.

### P0-3. `timeout.deadlineMs` decision executed

**Status (Milestone 4):** Executed. `TimeoutOptions` no longer includes `deadlineMs`. Passing it throws `ConfigurationError`. `ContextInit.deadline` / `deadlineMs` remains the overall bound.

`TimeoutOptions.deadlineMs` is public, validated (`>= perAttemptMs`), stored, and **never applied** by the timeout policy. Runtime timeout is `perAttemptMs` only. Root `ContextInit.deadline` / `deadlineMs` is a separate, working mechanism.

A public option that validates and does nothing violates the project’s fail-loudly rule (`retry.jitter: "full"` already throws).

**Required for beta:** pick one and ship it:

| Option        | Meaning                                                   | Recommendation              |
| ------------- | --------------------------------------------------------- | --------------------------- |
| **Reject**    | Throw `ConfigurationError` like unimplemented jitter      | **Preferred**               |
| **Remove**    | Drop from `TimeoutOptions`                                | Acceptable                  |
| **Implement** | Enforce an overall request deadline in the timeout policy | Defer to 1.0 unless cheap   |
| **Document**  | Leave the silent no-op                                    | **Not acceptable for beta** |

Context-level `deadlineMs` on `execute()` can remain.

### P0-4. No known P0 semantic defects in shipping behavior

Streaming post-commit timeout is fixed in `0.1.0-alpha.4`. Unary retry/timeout are covered. Beta cannot ship with a known equivalent of “retries after committed text.” Any new P0 found during the hardening pass blocks the tag.

### P0-5. Repeatable packed-consumer + dependency-graph gate

**Classification: P0 for release engineering, not for runtime design.**

Today this is a manual release ritual. Beta installs will be real. CI (or a script CI always runs) must prove:

- packed tarballs have **no** `workspace:*`
- a fresh consumer sees **one** `@resili/core` and **one** `@resili/llm`
- ESM `import` and CJS `require()` both resolve

Without this, a beta publish can recreate the alpha.4 dependency-range incident.

---

## P1 — Required Before Beta

Should be completed unless a dated, written deferral exists.

| ID    | Item                                                                 | Why                                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | `RESILI_VERSION` reports the real `@resili/core` version             | Public export is `"0.0.0"`; tests assert the placeholder. Misleading for diagnostics.                                                                                                                                                  |
| P1-2  | `stats()` / `health()` honesty                                       | Totals work. `circuit` / `bulkhead` / `rateLimiter` maps are **always empty**. `health()` is therefore almost always `"healthy"`. Narrow the type, populate the maps, or document as totals-only **and** stop implying circuit health. |
| P1-3  | Export or hide forgotten core types                                  | `RetryBackoff`, `RetryJitter`, `RateLimiterStrategy`, etc. appear in public option types but are not entry exports.                                                                                                                    |
| P1-4  | API Extractor (or equivalent) for `@resili/llm`                      | LLM is a separate version line with its own freeze surface.                                                                                                                                                                            |
| P1-5  | HTTP adapter lifecycle surface                                       | Adapters wrap a `Client` but return only the call function. No `on`, no `destroy`. Event subscriptions and plugin disposal are unreachable.                                                                                            |
| P1-6  | Core interaction test matrix (see [Testing Matrix](#testing-matrix)) | Isolated policy tests are strong; cross-policy cancellation/retry cases are thin.                                                                                                                                                      |
| P1-7  | LLM adversarial regression gate in CI                                | Commit-point, pre/post-commit timeout, Budget Guard reserve/settle, abort. Keep the alpha.4 tests green on every PR.                                                                                                                   |
| P1-8  | Node 20 + 22 in CI                                                   | `engines` says `>=20`; CI is Node 22 only. Node 24 is P1 if still in LTS at release, else P2.                                                                                                                                          |
| P1-9  | ESM + CJS consumer smoke in CI                                       | Dual `exports` are declared; not proven per package in automation.                                                                                                                                                                     |
| P1-10 | Dist-tag policy for the beta channel                                 | Publish beta with `--tag beta`. Do **not** move `latest`. Decide whether `alpha` stays or freezes. Document install as `@beta`.                                                                                                        |
| P1-11 | Align `@resili/llm-gemini` version with the LLM line at beta cut     | `0.1.0-alpha.3` vs siblings `0.1.0-alpha.4` is explainable; beta should not repeat the skew.                                                                                                                                           |
| P1-12 | `retry.jitter` / `retry.idempotentOnly` public-type honesty          | Types accept values that throw at build. Keep throwing **or** narrow the types before freeze. Do not silently implement.                                                                                                               |
| P1-13 | Documentation beta audit                                             | Walk the [Documentation](#documentation) checklist as a stranger. Fix remaining holes.                                                                                                                                                 |
| P1-14 | HTTP adapter consistency notes frozen                                | Status codes not classified; bodies not cloned; injected-client retries not disabled. Document as contract, not bugs, unless changed.                                                                                                  |
| P1-15 | Error-code and classification freeze                                 | Core `ResiliErrorCode` + LLM `LlmErrorClassification` lists below become append-only for beta.                                                                                                                                         |

---

## P2 — Can Wait

Safe to land during beta or shortly after. Not an excuse to ignore if cheap.

| ID    | Item                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| P2-1  | Node 24 matrix job (if not already P1)                                          |
| P2-2  | Implement `retry.jitter: "full" \| "equal"` with injectable randomness          |
| P2-3  | Implement `retry.idempotentOnly`                                                |
| P2-4  | Implement overall `timeout.deadlineMs` **if** P0-3 chose reject/remove instead  |
| P2-5  | Populate live policy snapshots for `stats()` **if** P1-2 chose to keep the maps |
| P2-6  | HTTP status-classification helpers (`retryOn` presets for 408/429/5xx)          |
| P2-7  | Adapter `destroy` / `on` ergonomics beyond the minimum P1-5                     |
| P2-8  | Streaming TTFB timeout and idle/chunk timeout                                   |
| P2-9  | Cache LRU; concurrent-miss coalescing without composing dedupe                  |
| P2-10 | Hedge `maxAttempts > 2`                                                         |
| P2-11 | First-party OpenTelemetry / Prometheus plugins                                  |
| P2-12 | Markdown link check in CI                                                       |
| P2-13 | API Extractor for HTTP adapter packages                                         |
| P2-14 | `createFetch` dummy `about:blank` operation used only to satisfy `createClient` |

---

## Public API Review Required

### `@resili/core` (API Extractor exists)

Review every export in `packages/core/etc/core.api.md` and `packages/core/src/index.ts`.

Pay special attention to:

- `RESILI_VERSION`
- `Client.stats` / `Client.health` / `ClientStats` policy maps
- `TimeoutOptions.deadlineMs`
- `RetryOptions.jitter` and `idempotentOnly`
- Unexported types referenced by public options
- Event map (closed, 29 types) — freeze names and payload fields
- `Context.metadata` shallow-reuse contract (required by LLM streaming; do not break)
- `definePolicy` / `definePlugin` / `PolicyOrder` relative anchors

### `@resili/llm` (no API Extractor)

Review `packages/llm/src/index.ts`. Confirm internal keys stay unexported:

- `LLM_STREAM_COMMIT_STATE_KEY`
- `LLM_REQUEST_METADATA_KEY`
- `withStreamCommitRetryGuard`, `markLlmStreamCommitted`

Public freeze candidates: `createLlmClient`, `LlmClient`, `LlmGenerateRequest` (`input: string`), `LlmStream*`, `LlmError` / `LlmBudgetExceededError`, classifications, `llmClassifier`, pricing helpers, `BudgetGuardOptions`, `LLM_METRIC_NAMES`, event names.

`LlmError` extends `Error`, not `ResiliError`. `isResiliError()` is false for LLM errors. Freeze that split; document it.

### HTTP adapters (no API Extractor)

`createFetch` / `createAxios` / `createUndici` plus structural types. Freeze: no status classification, signal composition (after P0-1), injection model, verb helpers on axios only.

### Review status

**Not started as a freeze.** Documentation exists. Forgotten-export warnings are outstanding. LLM/HTTP have no report file.

---

## Core Readiness

Default pipeline (outer → inner): Fallback → Cache → Retry → Circuit breaker → Timeout → Dedupe → Hedge → Rate limiter → Bulkhead → Operation.

Retry is **outside** timeout: each attempt gets a fresh `perAttemptMs`. That is the shipped semantic. Freeze it.

| Component            | Status                        | Known risks                                                                                | Beta blocker?     | Test gaps                            |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------ |
| Retry                | Implemented                   | Unimplemented jitter/idempotentOnly throw. `RetryExceededError` only when still retryable. | No                | Interaction with admission + breaker |
| Timeout              | Per-attempt only              | `deadlineMs` no-op on the policy                                                           | **Yes (honesty)** | Overall deadline if implemented      |
| Circuit breaker      | In-memory, % thresholds       | `failureRateThreshold` is percent not fraction                                             | No                | Retry × open × recovery              |
| Bulkhead             | Concurrency + optional queue  | Default `maxQueue: 0`. Rejections retryable, not failures                                  | No                | Queue timeout × caller abort         |
| Rate limiter         | Token bucket + sliding window | `maxWaitMs` required for `wait`, rejected for `reject`                                     | No                | Wait × timeout × retry               |
| Fallback             | Outermost                     | No events. Catches `RetryExceededError` unless `fallbackOn` says no                        | No                | Abort vs fallback                    |
| Hedge                | Exactly 2 attempts            | Multiplies inner load. Retry × hedge is a foot-gun                                         | No                | Hedge × abort × timeout              |
| Dedupe               | In-flight only                | Shared abort when unused. Not a cache                                                      | No                | Joiner abort × owner abort           |
| Cache                | FIFO, successes only          | Concurrent misses not coalesced                                                            | No                | Cache × retry (hit skips retry)      |
| Policy ordering      | Deterministic + relative      | Custom-to-custom anchors unsupported                                                       | No                | Budget `{ before: "retry" }` stays   |
| Execution context    | Immutable + fork              | Metadata **values** reused by reference across forks                                       | No                | Keep streaming commit tests          |
| Metadata             | Shallow reuse                 | Mutating nested objects is visible across attempts **by design**                           | No                | Document; do not “fix”               |
| Cancellation         | `AbortSignal` native          | HTTP adapters do not take caller signal                                                    | **Yes (HTTP)**    | Full cancellation matrix             |
| Events               | Closed core map               | Handler errors swallowed. Fallback silent                                                  | No                | Payload privacy regression           |
| Metrics              | Low-cardinality contract      | Only some policies record; `requestId` must never be a label                               | No                | Cardinality lint if added            |
| Error classification | `httpClassifier` + pluggable  | HTTP **responses** with status are not errors unless `retryOn`                             | No                | Freeze 429-not-failure               |

In-memory, process-local policy state is an accepted alpha/beta limitation, not a blocker.

---

## HTTP Readiness

| Topic                   | fetch                         | axios                      | undici                                      |
| ----------------------- | ----------------------------- | -------------------------- | ------------------------------------------- |
| Call shape              | `(input, init?) => Response`  | Callable + verb helpers    | `(origin, path, …) => { statusCode, body }` |
| Injection               | Optional (`globalThis.fetch`) | Required                   | Required                                    |
| Peer dependency         | none                          | none (structural)          | none (structural)                           |
| Status classification   | None                          | None                       | None                                        |
| Signal to transport     | Overwrites `init.signal`      | Overwrites `config.signal` | Overwrites `options.signal`                 |
| Caller signal to Resili | Passed via `ContextInit`      | Passed via `ContextInit`   | Passed via `ContextInit`                    |
| Client `on` / `destroy` | Hidden                        | Hidden                     | Hidden                                      |
| Body replay             | Same reference                | Same reference             | Same reference; body must be drained        |

**Inconsistencies to resolve or freeze before beta**

1. **Cancellation (P0)** — must become consistent and caller-visible.
2. **Lifecycle (P1)** — either expose `on`/`destroy` (or a `client` handle) on all three, or document that adapters are fire-and-forget and plugins should not be used there.
3. **Default vs inject** — fetch defaults; others require injection. Freeze; it is reasonable.
4. **Status field names** — `status` vs `statusCode`. Freeze; matches the underlying libraries.
5. **axios `validateStatus`** — if the injected instance rejects non-2xx, Resili sees errors; if it does not, Resili sees values. Not adapter magic. Document.
6. **Do not disable injected retries** — freeze as caller responsibility unless a later 1.0 helper exists.

HTTP adapters are otherwise beta-capable once cancellation and lifecycle honesty land.

---

## LLM Readiness

| Area                          | Status                                                                            | Beta blocker? |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------- |
| `generate()`                  | Text-in / text-out. Usage + optional cost.                                        | No            |
| `stream()`                    | Pull-through, lazy start, commit after first non-empty `text-delta`               | No            |
| Provider contract             | `execute` required; `stream` optional                                             | No            |
| Retry ownership               | SDK retries disabled (0 / attempts 1)                                             | No            |
| Post-commit semantics         | No second generation; timeout → `LlmError("timeout", retryable: false)`           | No            |
| Pre-commit timeout exhaustion | `RetryExceededError` preserved                                                    | No            |
| Timeout                       | Full attempt including consumer pull; no TTFB/idle                                | No (document) |
| Cancellation                  | Request `signal` composed; early `break` → `AbortError`                           | No            |
| Budget Guard                  | Estimate → reserve → settle; process-local; estimate can undershoot               | No            |
| Pricing                       | Caller table; micro-USD; unknown ≠ $0                                             | No            |
| Usage                         | Normalized tokens + `dimensions` (unpriced)                                       | No            |
| Errors                        | 12 classifications including `budget`, `content_policy`, `context_limit_exceeded` | No            |
| Telemetry / metrics           | No prompts/text/keys; stream lifecycle events; `committed` on failure             | No            |
| OpenAI                        | Chat Completions; first choice; Responses API deferred                            | No            |
| Anthropic                     | Messages; partial usage merge                                                     | No            |
| Gemini                        | `@google/genai`; cumulative snapshot de-dup; first candidate                      | No            |

Tools, multimodal, embeddings, extra providers, and Responses API are **not** beta blockers. Freeze text-in/text-out `input: string`.

Keep the commit-point invariant as a **release gate**, not as new scope.

---

## Testing Matrix

Current: **598 tests / 38 files**. Do not accept a silent drop.

Policy-level files are dense (hedge 41, cache 32, dedupe 36, stream 35). Cross-cutting files are not.

| Gap                                                                                                       | Priority           | Notes                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| Policy interaction matrix (retry×timeout, retry×breaker, retry×rate limiter, retry×bulkhead, cache×retry) | **P1**             | Exists only as scattered cases                     |
| Cancellation matrix (caller, timeout, retry delay, dedupe joiners, hedge losers, fallback)                | **P1**             | HTTP caller abort currently impossible             |
| Dedupe + cancellation                                                                                     | **P1**             | Some coverage in dedupe tests; complete the matrix |
| Hedge + cancellation / timeout                                                                            | **P1**             |                                                    |
| Stream + retry + timeout (pre and post commit)                                                            | **P0/P1**          | Strong in `stream.test.ts`; must stay in CI        |
| Budget Guard retry / cancel / failure                                                                     | **P1**             | `budget.test.ts` + stream cases                    |
| Concurrent clients / concurrent streams                                                                   | **P1**             |                                                    |
| Real SDK package-shape integration                                                                        | **P2**             | Structural mocks today; optional live jobs         |
| Packed consumer                                                                                           | **P0**             | CI, not only release day                           |
| ESM / CJS                                                                                                 | **P1**             |                                                    |
| Node 20 / 22 / 24                                                                                         | **P1** / P2 for 24 | CI matrix                                          |
| HTTP adapter caller abort (after P0-1)                                                                    | **P0**             | New tests required                                 |
| `stats()` / `health()` contract tests                                                                     | **P1**             | Match whatever honesty decision is made            |

---

## CI / Release Engineering

Current `.github/workflows/ci.yml`: Node **22** only. Format, lint, core build, typecheck, test, full build, `@resili/core api:check`. Docs workflow generates TypeDoc on path filters.

| Check                                    | Today       | Beta requirement                       |
| ---------------------------------------- | ----------- | -------------------------------------- |
| Lint / format / typecheck / test / build | CI          | Keep                                   |
| `@resili/core` API check                 | CI          | Keep                                   |
| `@resili/llm` API check                  | Absent      | P1                                     |
| Node 20                                  | Absent      | P1                                     |
| Node 22                                  | CI          | Keep                                   |
| Node 24                                  | Absent      | P1 or P2                               |
| `pnpm pack` / tarball inspect            | Manual      | **P0**                                 |
| `workspace:*` leakage                    | Manual      | **P0**                                 |
| Duplicate `@resili/core` / `@resili/llm` | Manual      | **P0**                                 |
| ESM consumer                             | Manual      | P1                                     |
| CJS consumer                             | Manual      | P1                                     |
| Artifact safety (no secrets, no `.env`)  | Informal    | P1 script                              |
| Provenance / `latest` protection         | Policy only | Document; do not move `latest` at beta |

Anything currently done only during a human release should have a CI job or a `pnpm` script that CI always runs.

---

## Error Contract

### Core (`ResiliError`, `isResiliError`)

| Class                    | Code                 | Default failure  | Default retryable |
| ------------------------ | -------------------- | ---------------- | ----------------- |
| `ConfigurationError`     | `ERR_CONFIG`         | n/a (build time) | n/a               |
| `CircuitOpenError`       | `ERR_CIRCUIT_OPEN`   | No               | No                |
| `TimeoutError`           | `ERR_TIMEOUT`        | Yes              | Yes               |
| `RetryExceededError`     | `ERR_RETRY_EXCEEDED` | Yes              | No                |
| `BulkheadRejectedError`  | `ERR_BULKHEAD_FULL`  | No               | Yes               |
| `RateLimitExceededError` | `ERR_RATE_LIMITED`   | No               | Yes               |
| `AbortError`             | `ERR_ABORTED`        | No               | No                |

Also: errors with `name === "AbortError"` are treated as abort by `httpClassifier`.

### LLM (`LlmError`, `isLlmError`) — 12 classifications, not 9

Exact names from `packages/llm/src/errors.ts`:

`authentication`, `authorization`, `invalid_request`, `rate_limited`, `timeout`, `provider_unavailable`, `overloaded`, `context_limit_exceeded`, `content_policy`, `network_transient`, `budget`, `unknown`.

Default retryable: `rate_limited`, `timeout`, `provider_unavailable`, `overloaded`, `network_transient`.

Not retryable: the rest, including `unknown` and `budget`.

`LlmBudgetExceededError` is `classification: "budget"`.

Streaming freeze:

- Pre-commit timeout exhaustion → `RetryExceededError` (`lastError` is `TimeoutError`).
- Post-commit timeout → `LlmError("timeout")` with `retryable: false`.

Stabilize these names and the two-hierarchy split before beta. Adding classifications later is allowed; renaming is not.

---

## Observability Contract

### Core events — treat as stable for beta

Lifecycle: `RequestStarted`, `RequestCompleted`.

Retry: `RetryStarted`, `RetryCompleted`, `RetryFailed`.

Timeout: `TimeoutTriggered`.

Circuit: `CircuitOpened`, `CircuitHalfOpened`, `CircuitClosed`.

Admission: `RateLimited`, `BulkheadRejected`.

Cache / Dedupe / Hedge: the names already on `ResiliEventType`.

Payloads are frozen at the field names in `ResiliEventMap`. Do not add prompts or cache keys.

### LLM events — treat as stable for beta

`LlmRequestStarted`, `LlmRequestCompleted`, `LlmRequestFailed`, `LlmUsageRecorded`, `LlmBudgetWarning`, `LlmBudgetRejected`, `LlmStreamStarted`, `LlmStreamCompleted`, `LlmStreamFailed`.

`LlmStreamFailed.committed` is part of the contract. Text deltas are **not** events.

### Metrics

Low cardinality. `requestId` is never a label. LLM metrics use `result` = `success` \| `failure` \| `budget_rejected`. No first-party exporter required for beta.

### Misleading APIs

`stats()` / `health()` — see P1-2. Do not freeze the empty maps as if they were live.

Privacy guarantee (no prompts, completions, chunks, API keys, `Authorization` headers) is already a beta invariant.

---

## Documentation

A new developer can already, from `docs/` + package READMEs:

- Install core / HTTP / LLM with `@alpha`
- Configure retry + timeout
- Use fetch, axios, undici (including “status is not a failure”)
- Understand policy order
- Handle core and LLM errors
- Use `AbortSignal` on **core** and **LLM**
- Use OpenAI / Anthropic / Gemini
- `generate()` and `stream()` (including commit point)
- Configure pricing and Budget Guard
- Subscribe to events / record metrics

**Remaining documentation blockers (after P0/P1 land)**

- [ ] HTTP adapter cancellation examples match the new behavior (P0-1).
- [ ] `timeout.deadlineMs` docs match reject/remove/implement (P0-3).
- [ ] `RESILI_VERSION` and `stats()`/`health()` described accurately (P1-1, P1-2).
- [ ] Beta install commands (`@beta`) and dist-tag table (P1-10).
- [ ] This file linked from `docs/README.md` and `docs/releases/` navigation.
- [ ] Maintainer specs (`ARCHITECTURE.md`, `INTERNAL_DESIGN.md`) still call some shipped policies “future” in places — historical, not user-guide blockers, but confusing during API review.

No documentation P0 remains **if** the code decisions above are reflected. Shipping beta docs that still say “pass your signal in `init`” while ignoring it would be a P0 doc bug.

---

## Deferred Features

| Feature                               | Class                                           | Notes                                   |
| ------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| HTTP caller cancellation              | **A. required before beta**                     | P0-1                                    |
| Public API freeze + honesty pass      | **A**                                           | P0-2, P0-3, P1-1, P1-2                  |
| Packed consumer / Node matrix in CI   | **A**                                           | P0-5, P1-8, P1-9                        |
| OpenAI Responses API                  | **C. post-1.0**                                 | Chat Completions is the beta surface    |
| LLM tools / function calling          | **C**                                           | Would change `input` / events           |
| Multimodal                            | **C**                                           |                                         |
| Embeddings                            | **C**                                           |                                         |
| Additional providers (Azure, Bedrock) | **C**                                           | Azure via injected OpenAI client today  |
| TTFB timeout                          | **B. before stable 1.0** (or C if still unused) | Document limitation for beta            |
| Streaming idle / chunk timeout        | **B or C**                                      | Same                                    |
| Distributed Budget Guard              | **C**                                           | Process-local is accepted               |
| First-party telemetry integrations    | **C**                                           | Contract is enough for beta             |
| Distributed policy state              | **C**                                           | `StateStore` seam exists                |
| Persistent circuit / rate-limit state | **C**                                           |                                         |
| Dashboard / UI                        | **D. optional**                                 | Out of product scope                    |
| Implement jitter / idempotentOnly     | **C**                                           | Honesty (throw or narrow types) is A/P1 |
| Overall request deadline policy       | **B**                                           | After rejecting the silent option       |

---

## Breaking Changes Before Beta

Change these **now**, while still alpha. Do not implement in this planning task.

### 1. HTTP caller cancellation

- **Current API:** Adapter overwrites request `signal`; `execute` is called with no `ContextInit`. Caller abort is ignored.
- **Proposed direction:** Caller signal on the adapter call aborts the logical Resili request; transport still sees composed `ctx.signal`.
- **Why:** Fetch-shaped APIs are expected to honor `AbortSignal`.
- **Migration cost now:** Low. Anyone relying on ignored signals is not a real consumer pattern.
- **Migration cost after beta:** High. Apps will build abort UIs on the adapter.
- **Priority:** P0
- **Recommendation:** **Do it before beta.** Prefer additive composition over a new unrelated options bag if the existing call shape can carry the signal.

### 2. `timeout.deadlineMs` silent no-op

- **Current API:** Optional, validated, unused by the timeout policy.
- **Proposed direction:** Throw `ConfigurationError` (preferred) or remove the field.
- **Why:** Fail loudly. Matches jitter.
- **Migration cost now:** Near zero (the option never worked).
- **Migration cost after beta:** Callers copy-paste a field that does nothing, then a later 1.0 throw breaks them.
- **Priority:** P0
- **Recommendation:** **Reject at config time** before beta.

### 3. `ClientStats` policy maps / `health()`

- **Current API:** Maps always `{}`; `health()` cannot see open circuits.
- **Proposed direction:** Remove maps from the public snapshot **or** wire them. Do not freeze a lie.
- **Why:** Readiness probes will trust `health()`.
- **Migration cost now:** Low (nothing useful is in the maps).
- **Migration cost after beta:** Anyone dashboarding `stats().circuit` will break when it suddenly fills, or will never notice outages if it stays empty.
- **Priority:** P1
- **Recommendation:** **Narrow or wire before freeze.** Prefer totals-only public type if wiring is large.

### 4. `RESILI_VERSION`

- **Current API:** `"0.0.0"` (tested).
- **Proposed direction:** Literal matching `@resili/core` version.
- **Why:** Support and telemetry.
- **Migration cost now:** One test change.
- **Migration cost after beta:** Tools may special-case `"0.0.0"`.
- **Priority:** P1
- **Recommendation:** **Fix before beta.** Not a semantic break.

### 5. Unimplemented retry options in the public type

- **Current API:** `jitter?: "none" \| "full" \| "equal"`; `idempotentOnly?: boolean`; non-defaults throw.
- **Proposed direction:** Narrow types to implemented values **or** keep throw + docs.
- **Why:** Types that accept illegal configs are a freeze foot-gun.
- **Migration cost now:** Type-only for people who already cannot pass `"full"`.
- **Migration cost after beta:** Implementing later changes runtime delay distributions.
- **Priority:** P1
- **Recommendation:** Narrow `jitter` to `"none"` in the public type for beta; keep a commented extension path. Leave implementation for post-beta.

### 6. Forgotten public types

- **Current API:** Referenced but not exported; API Extractor warnings.
- **Proposed direction:** Export one `KeyResolver`, `RetryBackoff`, `RetryJitter`, `RateLimiterStrategy`, `RateLimiterLimitBehavior`, `CircuitBreakerWindow`, `ResiliErrorOptions`.
- **Why:** Typed config without `any`.
- **Migration cost now:** Additive.
- **Migration cost after beta:** Still additive, but freeze review should not leave warnings.
- **Priority:** P1
- **Recommendation:** **Export before beta.**

### 7. HTTP adapter client handle

- **Current API:** Function-only return; inner `Client` is unreachable.
- **Proposed direction:** Expose `on` / `destroy` (and maybe `stats`) without breaking the callable shape.
- **Why:** Plugins, events, disposal.
- **Migration cost now:** Additive if the function remains callable.
- **Migration cost after beta:** Forcing a breaking extra return field later.
- **Priority:** P1
- **Recommendation:** Additive handle or methods on the function object before freeze.

**Do not break for beta:** pipeline order, commit-point, `LlmGenerateRequest.input: string`, classifier 429-not-failure, process-local state, independent version lines, `LlmError` not extending `ResiliError`.

---

## Beta Exit Criteria

- [x] HTTP cancellation design approved (caller signal aborts the logical request on all three adapters)
- [x] HTTP cancellation implemented and tested (caller abort, timeout abort, composition, no retry)
- [x] Public API review completed for all eight packages (keep / export / hide)
- [x] Forgotten `@resili/core` API Extractor warnings resolved or explicitly accepted
- [ ] `@resili/llm` public surface recorded (API Extractor or equivalent)
- [x] `timeout.deadlineMs` decision shipped (reject or remove; not a silent no-op)
- [x] `RESILI_VERSION` reports the real core version
- [x] `stats()` / `health()` decision shipped (narrow, wire, or documented totals-only **and** types match)
- [x] `retry.jitter` / `idempotentOnly` types match runtime
- [ ] Core interaction test matrix passes (retry×timeout, retry×breaker, retry×admission, cache×retry)
- [ ] Cancellation matrix passes (core + HTTP + LLM stream)
- [ ] LLM adversarial matrix passes (pre/post-commit timeout, no duplicate generation, Budget Guard settle)
- [ ] Node 20 and Node 22 CI jobs pass
- [ ] Packed consumer gate passes (no `workspace:*`, single core, single llm)
- [ ] ESM and CJS consumer smokes pass
- [ ] Artifact safety check passes (no secrets, no `.env`, no unexpected files)
- [ ] Documentation beta audit passes (install `@beta`, cancellation, deadline, stats, versions)
- [ ] Dist-tag policy applied: publish `--tag beta`; `latest` unchanged
- [ ] Gemini version aligned with the LLM line at cut
- [ ] HTTP adapter lifecycle (`on` / `destroy`) exposed or explicitly out of scope in the freeze notes
- [ ] Error codes and LLM classifications frozen (append-only)
- [ ] Event names listed in this document frozen
- [ ] No known P0 issues
- [ ] Test count not silently below the current baseline without a written reason
- [ ] Beta package dependency graph verified on a clean consumer install

---

## Stable v1.0 Exit Criteria

Separate from beta. Do **not** wait for tools, embeddings, dashboards, or distributed state.

- [ ] Beta used in real applications (more than the maintainers)
- [ ] No unresolved high-severity semantic bugs (especially streaming, retry, cancellation)
- [ ] API proven stable through the beta window (no emergency breaks)
- [ ] Compatibility matrix proven: Node versions in `engines`, ESM and CJS, supported SDK peers
- [ ] Documentation matches the frozen API; alpha-era “not implemented” traps gone
- [ ] Release process repeatable: CI gates === publish gates
- [ ] Semver policy finalized (what is a break on 1.x)
- [ ] `latest` dist-tag **intentionally** moved to the first stable
- [ ] Independent core/HTTP vs LLM version lines still documented
- [ ] Overall-request deadline story decided (implement or permanently absent)
- [ ] `health()` / `stats()` truthful enough for production probes
- [ ] Privacy guarantees still hold

---

## Recommended Milestones

Shortest path from current `main` to a beta tag. Adjust only with a written scope change.

### Milestone 1 — Beta scope freeze

- **Objective:** Treat this document as the scope. No new product themes.
- **Areas:** `docs/releases/BETA_READINESS.md`, issue labels, dist-tag note.
- **Exit:** P0/P1 list agreed; deferred table agreed.
- **Type:** Review
- **Effort:** S

### Milestone 2 — API review

- **Objective:** Walk every public export. Record keep/export/hide. Resolve forgotten types. Decide deadlineMs, stats/health, RESILI_VERSION, jitter types.
- **Areas:** `packages/core/etc/core.api.md`, `packages/*/src/index.ts`, new llm API report if added.
- **Exit:** Written freeze notes; P0-2 and P0-3 decisions recorded.
- **Type:** Review (+ tiny type exports)
- **Effort:** M

### Milestone 3 — HTTP cancellation

- **Objective:** Caller `AbortSignal` aborts the logical request on fetch, axios, and undici.
- **Areas:** `packages/fetch`, `packages/axios`, `packages/undici`, HTTP docs, examples.
- **Exit:** P0-1 tests green; docs match.
- **Type:** Coding
- **Effort:** M

### Milestone 4 — Core contract honesty + interaction hardening

- **Status:** Complete and merged (`fix(core): harden public API for beta (#31)`).
- **Objective:** Implement Milestone 2 decisions (`deadlineMs` reject/remove, version, stats types). Add interaction and cancellation tests.
- **Areas:** `packages/core` (timeout validation, client stats types, version), tests, core docs.
- **Exit:** P0-3, P1-1, P1-2, P1-6.
- **Type:** Coding
- **Effort:** M

### Milestone 5 — LLM / Budget / error hardening

- **Status:** Complete on `fix/llm-beta-api-lock` (not merged). API Extractor for four LLM packages; `tsbuild/` packaging; metrics typing honesty; freeze record `docs/releases/BETA_LLM_API_REVIEW.md`.
- **Objective:** No new features. Lock adversarial stream + budget tests in CI; add llm API report; confirm classifications frozen.
- **Areas:** `packages/llm`, provider tests already present, docs/llm.
- **Exit:** P1-4, P1-7, P1-15.
- **Type:** Coding / review
- **Effort:** S–M

### Milestone 6 — CI / package consumer automation

- **Objective:** Node 20+22, pack, `workspace:*` leak, duplicate deps, ESM/CJS smokes, optional artifact scan.
- **Areas:** `.github/workflows/ci.yml`, pack scripts.
- **Exit:** P0-5, P1-8, P1-9.
- **Type:** Coding (CI)
- **Effort:** M

### Milestone 7 — HTTP lifecycle + documentation beta audit

- **Objective:** Adapter `on`/`destroy` (or freeze without them). Docs/examples for `@beta`, cancellation, stats, version.
- **Areas:** HTTP packages, `docs/**`, `README.md`, `CHANGELOG.md`.
- **Exit:** P1-5, P1-10, P1-13.
- **Type:** Coding + docs
- **Effort:** S–M

### Milestone 8 — Beta readiness verification + release prep

- **Objective:** Tick every beta checkbox. Align Gemini version. Prepare `--tag beta` without moving `latest`. No publish in this milestone until a human says so.
- **Areas:** versions, CHANGELOG, pack, clean consumer.
- **Exit:** All beta exit criteria checked; recommendation to publish or not.
- **Type:** Review + release prep
- **Effort:** M

---

## Final Verdict

**B. READY AFTER SMALL HARDENING PASS**

The architecture does not block beta. Core policies, LLM streaming (including the alpha.4 commit fix), documentation, and the 598-test baseline are sufficient **capability**.

Beta is still blocked by a **bounded** honesty and DX program:

1. HTTP caller cancellation (real semantic gap on three published entry points).
2. Public API freeze, including silent `deadlineMs`, empty `stats()` maps, and `RESILI_VERSION`.
3. Repeatable pack/consumer/Node gates that today live only in release folklore.

That is more than a docs tweak and less than a rewrite. Do not expand beta to Responses API, tools, distributed state, or dashboards.

**Do not tag beta from current `main` as-is.**

---

## Audit trail (this document)

| Item                   | Finding                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| Branch                 | `main`                                                                  |
| HEAD                   | `cf1f224d053cb1000541cfaa4727e7be3db3a5df`                              |
| Working tree           | Clean at audit                                                          |
| HTTP cancellation      | **P0** — `execute` without `ContextInit`; signal overwritten            |
| `timeout.deadlineMs`   | Validated, unused — **P0 to reject or remove**                          |
| `RESILI_VERSION`       | `"0.0.0"` — **P1 fix**                                                  |
| `stats()` / `health()` | Totals live; policy maps always empty — **P1 honesty**                  |
| Dist-tags              | `alpha` current; `latest` = `0.1.0-alpha.1` — keep `latest` off beta    |
| LLM classifications    | 12 names including `budget`, `content_policy`, `context_limit_exceeded` |
| CI Node                | 22 only                                                                 |
| API Extractor          | Core only; forgotten-export warnings present                            |
