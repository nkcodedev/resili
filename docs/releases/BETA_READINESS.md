# Resili Beta Readiness

**Status:** Beta 1 **published**. See [`beta-status.md`](./beta-status.md) and [`versioning.md`](./versioning.md).

**Audited against (prep):** `main` @ `6a04616711900f7ba9be47035ad8669e45070365` (Milestone 7 docs merged)

**Test baseline (Milestone 7):** 641 tests / 42 files

This document is the authoritative beta readiness record from the pre-publish hardening program.
Source, tests, and CI override older unchecked boxes when they disagree.

---

## Current Status

Beta 1 is live on the public npm registry. `latest` and `beta` both resolve to Beta 1. Historical
`alpha` tags remain frozen on the final alpha line.

| Line        | Packages                                                      | Published      | npm `alpha` (historical) |
| ----------- | ------------------------------------------------------------- | -------------- | ------------------------ |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-beta.1` | `0.2.0-alpha.3`          |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-beta.1` | see versioning.md        |

**What is already true**

- Core wraps any async function. Zero runtime dependencies.
- Retry, timeout, circuit breaker, rate limiter, bulkhead, cache, fallback, dedupe, and hedge are implemented and unit-tested.
- HTTP adapters are thin, injected (except fetch’s global default), ESM+CJS, Node `>=20`, with caller `AbortSignal` cancellation and `on` / `destroy`.
- LLM `generate()` and `stream()` exist for OpenAI, Anthropic, and Gemini. Provider SDK retries are disabled.
- Streaming commit point is enforced (post-commit timeout does not retry).
- API Extractor reports exist for all eight publishable packages; freeze records say YES for Core, HTTP, and LLM/providers.
- `pnpm pack:check` proves packed metadata, artifact safety, one Core, one LLM, ESM+CJS, HTTP cancel, LLM generate/stream, post-commit timeout, and pre-commit retry.
- CI Validate + Packed consumer run on Node 20 and Node 22; required gate job named `Validate`.
- Gemini is aligned at `0.1.0-beta.1`.
- Public registry verification for Beta 1 passed.

**Follow-ups (non-blocking)**

- Standalone landing copy may still say Public Alpha until a website update.
- Package README relative-link / install-wording polish for npm rendering.

**Packaging (Milestone 6)**

- `tsup` owns `dist/` for all eight publishable packages. `tsc`/typecheck emit to `tsbuild/` so typecheck cannot overwrite packed bundles.
- `pnpm pack:check` (`scripts/check-packed-packages.mjs`) packs with **pnpm** (rewrites `workspace:*`), inspects tarballs, then installs them in a fresh directory under the OS temp dir (not the workspace) and runs ESM + CJS smokes.
- CI runs Validate + Packed consumer on **Node 20 and Node 22**. `pnpm api:check` covers all eight packages.
- Node 20 CI installs with `--config.engine-strict=false` because root `semantic-release@25` requires Node 22+. Published packages still declare `engines.node: ">=20"`; the packed-consumer job still runs on Node 20.

**Verdict in one line:** Beta 1 is published; install with plain `npm install @resili/core` (see [`versioning.md`](./versioning.md)).

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

| Package                 | Version        | Purpose                                                                | Runtime deps                   | Optional peers                | ESM/CJS | Status                |
| ----------------------- | -------------- | ---------------------------------------------------------------------- | ------------------------------ | ----------------------------- | ------- | --------------------- |
| `@resili/core`          | `0.2.0-beta.1` | Context, pipeline, 9 policies, events, metrics, errors                 | none                           | —                             | Yes     | Beta.1 Core/HTTP line |
| `@resili/fetch`         | `0.2.0-beta.1` | fetch-compatible wrapper                                               | `@resili/core` (`workspace:*`) | —                             | Yes     | Beta.1                |
| `@resili/axios`         | `0.2.0-beta.1` | axios-compatible wrapper; injected implementation                      | `@resili/core` (`workspace:*`) | none (structural; not a peer) | Yes     | Beta.1                |
| `@resili/undici`        | `0.2.0-beta.1` | undici-compatible `request` wrapper; injected implementation           | `@resili/core` (`workspace:*`) | none (structural; not a peer) | Yes     | Beta.1                |
| `@resili/llm`           | `0.1.0-beta.1` | Provider-neutral LLM client, usage, pricing, Budget Guard, telemetry   | `@resili/core` (`workspace:*`) | —                             | Yes     | Beta.1 LLM line       |
| `@resili/llm-openai`    | `0.1.0-beta.1` | Chat Completions unary + stream; `maxRetries: 0`                       | `@resili/core`, `@resili/llm`  | `openai >=4.0.0`              | Yes     | Beta.1                |
| `@resili/llm-anthropic` | `0.1.0-beta.1` | Messages unary + stream; `maxRetries: 0`                               | `@resili/core`, `@resili/llm`  | `@anthropic-ai/sdk >=0.20.0`  | Yes     | Beta.1                |
| `@resili/llm-gemini`    | `0.1.0-beta.1` | `@google/genai` generateContent / generateContentStream; `attempts: 1` | `@resili/core`, `@resili/llm`  | `@google/genai >=1.0.0`       | Yes     | Beta.1 (aligned)      |

Packed publishes pin `workspace:*` to the version from the same release run. Mixing packages across runs in one line is unsupported.

---

## P0 — Beta Blockers

Must be fixed or explicitly decided before a beta tag exists.

**Milestone 7 status: no open P0 correctness or packaging blockers.**

| ID   | Item                                     | Status                                                    |
| ---- | ---------------------------------------- | --------------------------------------------------------- |
| P0-1 | HTTP caller cancellation                 | **PASS** (Milestone 3 + packed smokes)                    |
| P0-2 | Public API freeze for all eight packages | **PASS** (Milestones 4–6)                                 |
| P0-3 | `timeout.deadlineMs` honesty             | **PASS** (rejects; Milestone 4)                           |
| P0-4 | No known P0 semantic defects             | **PASS** (post-commit stream fix in alpha.4; gates green) |
| P0-5 | Packed consumer + dependency-graph gate  | **PASS** (Milestone 6; `pnpm pack:check`)                 |

### P0-1. HTTP caller-initiated per-call cancellation

**Classification: P0. Beta blocker: yes.**

**Status (Milestone 3):** Implemented. Adapters pass the caller `signal` to `client.execute(operation, { signal })`. Transport still receives composed `ctx.signal`. Packed consumer smokes cover abort on fetch / axios / undici.

### P0-2. Public API freeze review completed

**Status (Milestones 4–6):** Written freeze records and committed API Extractor reports exist for all eight publishable packages. See `BETA_API_REVIEW.md`, `BETA_HTTP_API_REVIEW.md`, and `BETA_LLM_API_REVIEW.md`. `pnpm api:check` fails on report drift.

### P0-3. `timeout.deadlineMs` decision executed

**Status (Milestone 4):** Executed. Passing `timeout.deadlineMs` throws `ConfigurationError`. Use `ContextInit.deadline` / `deadlineMs` for an overall bound.

### P0-4. No known P0 semantic defects in shipping behavior

Streaming post-commit timeout is fixed in `0.1.0-alpha.4`. Packed consumer preserves the regression gate.

### P0-5. Repeatable packed-consumer + dependency-graph gate

**Status (Milestone 6):** Automated via `pnpm pack:check`.

---

## P1 — Before / during Beta

Milestone 7 classification:

| Class | Meaning                                                    |
| ----- | ---------------------------------------------------------- |
| **A** | Must complete before first beta **publish** (release prep) |
| **B** | Should land in release-prep docs/notes; not a code blocker |
| **C** | Safe to remain open during beta                            |

| ID    | Item                                      | Class | Status                                                                                                                 |
| ----- | ----------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| P1-1  | `RESILI_VERSION` real package version     | —     | **Done** (Milestone 4)                                                                                                 |
| P1-2  | `stats()` / `health()` honesty            | —     | **Done** (Milestone 4; totals-only)                                                                                    |
| P1-3  | Forgotten core types exported             | —     | **Done** (Milestone 4)                                                                                                 |
| P1-4  | API Extractor for LLM / providers         | —     | **Done** (Milestone 5)                                                                                                 |
| P1-5  | HTTP adapter `on` / `destroy`             | —     | **Done** (Milestone 6)                                                                                                 |
| P1-6  | Core interaction test matrix              | **C** | Partial coverage in `interactions.test.ts`; gaps (retry×rate limiter, retry×bulkhead dedicated cases) open during beta |
| P1-7  | LLM adversarial regressions in CI         | —     | **Done** (unit tests + packed consumer gate)                                                                           |
| P1-8  | Node 20 + 22 CI                           | —     | **Done** (Milestone 6)                                                                                                 |
| P1-9  | ESM + CJS consumer smoke in CI            | —     | **Done** (Milestone 6)                                                                                                 |
| P1-10 | Dist-tag policy for beta                  | **A** | **Decided** in `BETA_RELEASE_PLAN.md` (`--tag beta`; leave `latest`) — apply at publish                                |
| P1-11 | Align Gemini with LLM line at cut         | **A** | **Decided** — bump to `0.1.0-beta.1` with siblings at cut                                                              |
| P1-12 | `retry.jitter` / `idempotentOnly` honesty | —     | **Done** (Milestone 4)                                                                                                 |
| P1-13 | Documentation stranger audit              | **B** | Milestone 7 audit: sufficient for beta; switch install docs to `@beta` at cut; HTTP `on`/`destroy` noted in overview   |
| P1-14 | HTTP adapter consistency notes frozen     | **B** | Documented in HTTP overview / alpha-status; treat as contract                                                          |
| P1-15 | Error-code and classification freeze      | **B** | Lists in this doc + freeze records are append-only for beta                                                            |

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
| P2-13 | API Extractor for HTTP adapter packages                                         | **Done** (Milestone 6) |
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

Current baseline: **641 tests / 42 files** (`main` @ Milestone 7).

Policy-level files remain dense. Cross-cutting coverage improved in Milestone 4+ via `packages/core/src/core/pipeline/interactions.test.ts` and LLM `stream.test.ts` / packed consumer smokes.

| PAIR / SCENARIO                       | Covered? | Location                            | Beta blocker? |
| ------------------------------------- | -------- | ----------------------------------- | ------------- |
| Core retry + timeout                  | Yes      | `interactions.test.ts`              | No            |
| Core retry + circuit breaker          | Yes      | `interactions.test.ts`              | No            |
| Core retry + rate limiter             | Partial  | All-policies order smoke only       | No (C)        |
| Core retry + bulkhead                 | Partial  | All-policies order smoke only       | No (C)        |
| Core timeout + fallback               | Yes      | `interactions.test.ts`              | No            |
| Core dedupe + timeout                 | Yes      | `interactions.test.ts`              | No            |
| Core hedge + timeout                  | Yes      | `interactions.test.ts`              | No            |
| Core cache + retry                    | Yes      | `interactions.test.ts`              | No            |
| LLM retry + timeout (pre/post commit) | Yes      | `stream.test.ts` + pack smoke       | No            |
| LLM cancellation                      | Yes      | `stream.test.ts`                    | No            |
| LLM Budget Guard + retry/timeout      | Yes      | `stream.test.ts`                    | No            |
| LLM stream commit guard               | Yes      | `stream.test.ts` + pack smoke       | No            |
| LLM provider errors                   | Yes      | provider + stream tests             | No            |
| LLM concurrent streams / next()       | Yes      | `stream.test.ts`                    | No            |
| HTTP caller cancellation              | Yes      | `cancellation.test.ts` + pack smoke | No            |
| HTTP timeout / retry                  | Yes      | adapter index tests                 | No            |
| HTTP lifecycle `on` / `destroy`       | Yes      | adapter index tests                 | No            |

Do not block beta on expanding every Core interaction pair. Keep LLM commit-point and packed gates mandatory.

---

## CI / Release Engineering

Current `.github/workflows/ci.yml`: Node **20** and **22** matrix for Validate and Packed consumer; required aggregator job named `Validate`. Docs workflow generates TypeDoc on path filters.

| Check                                    | Today                        | Beta requirement             |
| ---------------------------------------- | ---------------------------- | ---------------------------- |
| Lint / format / typecheck / test / build | CI                           | Keep                         |
| API check (all 8 packages)               | CI (`pnpm api:check`)        | Keep                         |
| Node 20                                  | CI                           | Keep                         |
| Node 22                                  | CI                           | Keep                         |
| Node 24                                  | Absent                       | P2                           |
| `pnpm pack:check`                        | CI packed-consumer job       | Keep                         |
| `workspace:*` leakage                    | pack gate                    | Keep                         |
| Duplicate Core / LLM                     | pack gate                    | Keep                         |
| ESM / CJS consumer                       | pack gate                    | Keep                         |
| Artifact safety                          | pack gate                    | Keep                         |
| Provenance / `latest` protection         | Policy (`BETA_RELEASE_PLAN`) | Do not move `latest` at beta |

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

Milestone 7 stranger audit (no source reading required for basic paths):

| Task                              | Verdict                                                  |
| --------------------------------- | -------------------------------------------------------- |
| Install `@resili/core`            | **CLEAR** (`@alpha` today; `@beta` at cut)               |
| Configure retry + timeout         | **CLEAR**                                                |
| Use fetch / axios / undici        | **CLEAR**                                                |
| Cancel HTTP calls                 | **CLEAR** (overview + cancellation)                      |
| Understand policy order           | **CLEAR**                                                |
| Handle errors                     | **CLEAR**                                                |
| Use events / metrics              | **CLEAR**                                                |
| Use OpenAI / Anthropic / Gemini   | **CLEAR**                                                |
| `generate()` / `stream()`         | **CLEAR**                                                |
| Stream retry rules / commit point | **CLEAR**                                                |
| Pricing / Budget Guard            | **CLEAR**                                                |
| Cancel LLM calls                  | **CLEAR**                                                |
| Understand alpha / beta status    | **CLEAR** for alpha; beta plan in `BETA_RELEASE_PLAN.md` |
| HTTP `on` / `destroy`             | **CLEAR** after overview note (was easy to miss)         |

**Remaining documentation work at cut (not code blockers)**

- [ ] Install / versioning pages teach `@beta` when beta is published
- [ ] Dist-tag table includes `beta`
- [ ] CHANGELOG Beta section published with the cut

No documentation P0 remains.

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
- [x] `@resili/llm` public surface recorded (API Extractor)
- [x] `timeout.deadlineMs` decision shipped (reject; not a silent no-op)
- [x] `RESILI_VERSION` reports the real core version
- [x] `stats()` / `health()` decision shipped (totals-only types)
- [x] `retry.jitter` / `idempotentOnly` types match runtime
- [x] Core interaction coverage sufficient for beta (see Testing Matrix; residual pairs = C)
- [x] Cancellation coverage sufficient (core + HTTP + LLM stream)
- [x] LLM adversarial matrix passes (pre/post-commit timeout, no duplicate generation, Budget Guard settle)
- [x] Node 20 and Node 22 CI jobs pass
- [x] Packed consumer gate passes (no `workspace:*`, single core, single llm)
- [x] ESM and CJS consumer smokes pass
- [x] Artifact safety check passes
- [x] Documentation stranger audit passes for shipping surface
- [ ] Dist-tag policy **applied**: publish `--tag beta`; `latest` unchanged
- [ ] Gemini version aligned with the LLM line at cut (`0.1.0-beta.1`)
- [x] HTTP adapter lifecycle (`on` / `destroy`) exposed
- [x] Error codes and LLM classifications treated as append-only
- [x] Event names listed in this document frozen
- [x] No known P0 issues
- [x] Test count not silently below the current baseline without a written reason
- [ ] Beta package dependency graph verified on a **public registry** consumer install

Unchecked items are **release execution**, not correctness blockers. See [`BETA_RELEASE_PLAN.md`](./BETA_RELEASE_PLAN.md).

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

- **Status:** Complete and merged (`fix(llm): harden public API for beta (#32)`).
- **Exit:** P1-4, P1-7, P1-15 (append-only classifications).

### Milestone 6 — HTTP freeze + packaging + CI

- **Status:** Complete and merged (`chore(beta): add packaging and consumer release gates (#33)`).
- **Exit:** P0-5, P1-5, P1-8, P1-9, HTTP API Extractor.

### Milestone 7 — Final readiness review + version strategy

- **Status:** Complete on this review (docs only; no version bump).
- **Exit:** P0 re-audit PASS; version / dist-tag / Gemini / publish-order decisions in `BETA_RELEASE_PLAN.md`.
- **Verdict:** **READY FOR BETA RELEASE PREP**.

### Milestone 8 — Beta release prep + publish

- **Objective:** Bump to `0.2.0-beta.1` / `0.1.0-beta.1`, update `@beta` install docs, run the 27-item release gate, publish `--tag beta`, verify from the public registry.
- **Do not** move `latest`. Do not publish until a human authorizes it.
- **Type:** Release prep + execution
- **Effort:** M

---

## Final Verdict

**A. READY FOR BETA RELEASE PREP**

No open P0 correctness, API honesty, or packaging blockers. Remaining work is version bumps, `@beta` docs, publish with `--tag beta`, and public-registry verification — see [`BETA_RELEASE_PLAN.md`](./BETA_RELEASE_PLAN.md).

---

## Audit trail (Milestone 7)

| Item                  | Finding                                                    |
| --------------------- | ---------------------------------------------------------- |
| Branch                | `main`                                                     |
| HEAD                  | `4d25ac9ce948fc89b562490f99d50b56b9a2ec88`                 |
| Working tree at audit | Clean before doc edits                                     |
| Tests                 | 641 / 42                                                   |
| P0 blockers           | None                                                       |
| Version strategy      | Family lines: core/HTTP `0.2.0-beta.1`, LLM `0.1.0-beta.1` |
| Dist-tags             | Publish `--tag beta`; leave `latest`                       |
| Gemini                | Align to `0.1.0-beta.1` at cut                             |
