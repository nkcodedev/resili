# Resili Beta API Review

**Status:** Milestone 2 — public API freeze review. Planning only.

**Audited against:** `main` @ `cf1f224d053cb1000541cfaa4727e7be3db3a5df`

**Companion plan:** [`BETA_READINESS.md`](./BETA_READINESS.md)

**Working tree at audit:** `BETA_READINESS.md` untracked; this file is additive.

This review classifies **currently exported** public symbols from the eight published packages. Source entrypoints, `core.api.md`, and option-normalization code are the authority. Documentation is secondary.

---

## Scope

| In                                           | Out                                                            |
| -------------------------------------------- | -------------------------------------------------------------- |
| Every `export` from each package `index.ts`  | `@internal` helpers not re-exported                            |
| `@resili/core` API Extractor report          | Implementing any change                                        |
| Public option fields that TypeScript accepts | New product features (tools, Responses API, distributed state) |
| Behavior implied by exported call shapes     | Git tags, versions, npm dist-tags                              |

**Counts (current public surface):** 186 exported symbols.

| Package                 | Exports |
| ----------------------- | ------- |
| `@resili/core`          | 80      |
| `@resili/fetch`         | 4       |
| `@resili/axios`         | 6       |
| `@resili/undici`        | 6       |
| `@resili/llm`           | 52      |
| `@resili/llm-openai`    | 12      |
| `@resili/llm-anthropic` | 11      |
| `@resili/llm-gemini`    | 15      |

**Classification totals**

| Class                 | Count | Meaning                                      |
| --------------------- | ----- | -------------------------------------------- |
| KEEP                  | 157   | Freeze as-is for beta                        |
| REVIEW                | 15    | Keep unless freeze notes say otherwise       |
| CHANGE BEFORE BETA    | 14    | Shape or semantics must change before freeze |
| INTERNALIZE           | 0     | None must be removed from the public graph   |
| DEPRECATE BEFORE BETA | 0     | Nothing useful is being sunset               |

Plus **7 forgotten types** referenced by public options but not exported (see [Forgotten exports](#forgotten-exports)). Those are not in the 186; exporting them is additive CHANGE.

No currently exported symbol should be deleted before beta except as part of the 14 CHANGE items (narrowing fields, not deleting entry points).

---

## Package Inventory

Same as the readiness plan. Independent version lines. Dual ESM/CJS. Node `>=20`.

API Extractor reports exist for all eight publishable packages. `pnpm api:check` validates them without `--local`.

---

## Export Classification

### Summary of non-KEEP items

| Symbol                             | Package | Class  | Why                                        |
| ---------------------------------- | ------- | ------ | ------------------------------------------ |
| `RESILI_VERSION`                   | core    | KEEP   | Build-injected package version             |
| `TimeoutOptions`                   | core    | KEEP   | `perAttemptMs` only; `deadlineMs` rejected |
| `RetryOptions`                     | core    | KEEP   | `jitter?: "none"`; no `idempotentOnly`     |
| `ClientStats`                      | core    | KEEP   | Totals only                                |
| `ClientHealth`                     | core    | KEEP   | Always `"healthy"`; not a policy probe     |
| `Client`                           | core    | KEEP   | Honest `stats()` / `health()`              |
| `ResiliConfig`                     | core    | KEEP   | Includes `metrics`                         |
| `Builder`                          | core    | KEEP   | Includes `withMetrics`                     |
| `createFetch` / `ResilientFetch`   | fetch   | KEEP   | `on` / `destroy` added in Milestone 6      |
| `createAxios` / `ResilientAxios`   | axios   | KEEP   | Same                                       |
| `createUndici` / `ResilientUndici` | undici  | KEEP   | Same                                       |
| `FailureVerdict`                   | core    | REVIEW | Not used by `FailureClassifier`            |
| `CacheEventKeyType`                | core    | REVIEW | Event-payload only                         |
| `CacheEventValueType`              | core    | REVIEW | Event-payload only                         |
| `AxiosRequestConfig`               | axios   | REVIEW | `[key: string]: unknown`                   |
| `AxiosResponse`                    | axios   | REVIEW | Same index signature                       |
| `UndiciRequestOptions`             | undici  | REVIEW | Same                                       |
| `UndiciResponse`                   | undici  | REVIEW | Same                                       |
| `LlmProviderIdentity`              | llm     | REVIEW | Redundant with `LlmProvider.name`          |
| `LlmProviderStreamFrame`           | llm     | REVIEW | Easy to confuse with `LlmStreamEvent`      |
| `evaluateBudget`                   | llm     | REVIEW | Advanced / custom accountant               |
| `BudgetDecision`                   | llm     | REVIEW | Pairs with `evaluateBudget`                |
| `BudgetDecisionInput`              | llm     | REVIEW | Pairs with `evaluateBudget`                |
| `LlmFinishReason`                  | llm     | REVIEW | Includes `tool_calls` with no tools API    |
| `KeyResolver`                      | core    | KEEP   | Single shared type from policy module      |

All other listed exports are **KEEP**. Full KEEP lists are in the package sections below (grouped, not 157 bullets).

---

## @resili/core

Source: `packages/core/src/index.ts`, `packages/core/etc/core.api.md`.

### KEEP (grouped)

**Entry points:** `resili`, `createClient`, `Operation`, `Builder` (except metrics hole — listed CHANGE), `ResiliConfig` (except metrics hole).

**Client runtime:** `Context`, `ContextInit`, `ContextForkPatch`, `ContextSnapshot`, `Unsubscribe`.

`ContextInit.deadlineMs` **does** set a root deadline. That is not the same field as `TimeoutOptions.deadlineMs`. Keep context deadlines.

**Classification:** `FailureClassifier`, `Outcome`, `composeClassifier`, `httpClassifier`.

**Policies (factories + options that match runtime):**
`retryPolicy`, `timeoutPolicy`, `circuitBreakerPolicy`, `rateLimiterPolicy`, `bulkheadPolicy`, `cachePolicy`, `fallbackPolicy`, `dedupePolicy`, `hedgePolicy`,
and `RetryPredicate`, `BulkheadOptions`, `CacheOptions`, `CircuitBreakerOptions`, `DedupeOptions`, `DedupeKey`, `FallbackOptions`, `FallbackFn`, `HedgeOptions`, `RateLimiterOptions`.

`HedgeOptions.maxAttempts?: 2` is honest. Rate limiter `onLimit: "reject" | "wait"` both work. Cache/dedupe/fallback/bulkhead options match runtime.

**Extension:** `definePolicy`, `Policy`, `PolicyFactory`, `PolicyOrder`, `PolicyServices`, `Next`, `definePlugin`, `ResiliPlugin`, `PluginContext`, `PluginInstance`.

**State / time / metrics contracts:** `StateStore`, `PolicyState`, `memoryStore`, `Clock`, `systemClock`, `MetricsRecorder`, `Counter`, `Gauge`, `Histogram`, `Labels`, `noopMetrics`.

**Errors:** `ResiliError`, `ResiliErrorCode`, `isResiliError`, `ConfigurationError`, `TimeoutError`, `RetryExceededError`, `CircuitOpenError`, `RateLimitExceededError`, `BulkheadRejectedError`, `AbortError`.

**Events:** `ResiliEventType`, `ResiliEvent`, `ResiliEventBase`, `ResiliEventMap`, `EventHandler`. Freeze names and payload fields.

**Other:** `CircuitState`, `KeyResolver` (export the other copies too — REVIEW).

### CHANGE BEFORE BETA

#### `RESILI_VERSION`

|                     |                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Shape**           | `export const RESILI_VERSION = "0.0.0"`                                                        |
| **Problem**         | Tests assert the placeholder. Useless for support.                                             |
| **Direction**       | String equal to `@resili/core` package version (`0.2.0-alpha.3` today; `0.2.0-beta.N` at cut). |
| **Breaking?**       | Value change only.                                                                             |
| **Cost now**        | One constant + one test.                                                                       |
| **Cost after beta** | Tools may special-case `"0.0.0"`.                                                              |
| **Priority**        | P1 (readiness); freeze item                                                                    |
| **Recommendation**  | Fix before freeze.                                                                             |

#### `TimeoutOptions.deadlineMs`

|                     |                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Shape**           | `readonly deadlineMs?: number` on `TimeoutOptions`                                                                        |
| **Problem**         | Validated (`>= perAttemptMs`), stored, **never applied**. Per-attempt timeout only.                                       |
| **Direction**       | Throw `ConfigurationError` (preferred, matches `jitter: "full"`) **or** remove the field. Do not document a silent no-op. |
| **Breaking?**       | Yes for anyone who set it (it never worked).                                                                              |
| **Cost now**        | Near zero.                                                                                                                |
| **Cost after beta** | Copy-paste configs explode later when it starts throwing or starts working.                                               |
| **Priority**        | P0                                                                                                                        |
| **Recommendation**  | **Reject at config time.**                                                                                                |

Do **not** implement overall-request timeout in this field for beta unless it is a tiny follow-on. Context `deadlineMs` already exists.

#### `RetryOptions.jitter` / `idempotentOnly`

|                     |                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape**           | `jitter?: "none" \| "full" \| "equal"`; `idempotentOnly?: boolean`                                                                                          |
| **Problem**         | `"full"` / `"equal"` and `true` throw `ConfigurationError`. Types lie.                                                                                      |
| **Direction**       | Narrow public types to `jitter?: "none"` and omit `idempotentOnly`, **or** keep throw + export `RetryJitter` with docs. Prefer **narrow types** for freeze. |
| **Breaking?**       | Type-only for code that already cannot pass at runtime.                                                                                                     |
| **Cost now**        | Low.                                                                                                                                                        |
| **Cost after beta** | Implementing jitter later changes delay distributions under a frozen union.                                                                                 |
| **Priority**        | P1                                                                                                                                                          |
| **Recommendation**  | Narrow before freeze. Implementation is post-beta.                                                                                                          |

#### `ClientStats` / `ClientHealth` / `Client.stats` / `Client.health`

|                     |                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape**           | Maps `circuit`, `bulkhead`, `rateLimiter` plus `totals`. `health()` uses the maps.                                                                        |
| **Problem**         | `createStatsSnapshot` always supplies **empty** maps. Totals work (`calls`, `successes`, `failures`, `retries`). `health()` is almost always `"healthy"`. |
| **Direction**       | **A.** Public type is totals-only. **B.** Wire live snapshots from policies. Prefer **A** for beta (smaller).                                             |
| **Breaking?**       | A is a type break for anyone reading `.circuit`. Those maps were never populated.                                                                         |
| **Cost now**        | Low for A. Large for B.                                                                                                                                   |
| **Cost after beta** | Dashboards that trust `health()` will miss open circuits forever, or break when maps suddenly fill.                                                       |
| **Priority**        | P1                                                                                                                                                        |
| **Recommendation**  | Totals-only public snapshot for beta. Keep `CircuitState` for events.                                                                                     |

#### `ResiliConfig` / `Builder` — metrics hole

|                     |                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape**           | Config has `clock`, `store`, `classifier`. Builder has `withClock`, `withStore`, `withClassifier`. Plugins have `useMetrics`. LLM `CreateLlmClientOptions` has `metrics`. Core `ResiliConfig` does **not**. |
| **Problem**         | Cache/dedupe/hedge record metrics, but a core consumer cannot inject a recorder without a plugin. The public `MetricsRecorder` looks first-class and is not.                                                |
| **Direction**       | Add `metrics?: MetricsRecorder` to `ResiliConfig` and `withMetrics` on `Builder`. Additive.                                                                                                                 |
| **Breaking?**       | No.                                                                                                                                                                                                         |
| **Cost now**        | Small.                                                                                                                                                                                                      |
| **Cost after beta** | A later additive field is fine; freeze with a hole is embarrassing.                                                                                                                                         |
| **Priority**        | P1                                                                                                                                                                                                          |
| **Recommendation**  | Add before freeze.                                                                                                                                                                                          |

### REVIEW

| Symbol                                      | Note                                                                                                                  | Freeze default                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `FailureVerdict`                            | Document grouping; `FailureClassifier` uses two methods, not this object.                                             | KEEP unless you want to INTERNALIZE        |
| `CacheEventKeyType` / `CacheEventValueType` | Only in cache event payloads.                                                                                         | KEEP                                       |
| `KeyResolver`                               | Circuit-breaker export only; bulkhead and rate-limiter define identical unexported types (forgotten-export warnings). | Export one shared `KeyResolver`            |
| `PluginContext` comments                    | File comments still say “future builder integration”; runtime **does** install plugins.                               | KEEP API; fix comments in the honesty pass |

### Metadata / context (freeze)

- `Context.metadata` values are **shallowly reused** across forks. Required by LLM stream commit. Do not deep-clone in beta.
- `Context.fork` default `attemptNumber` is parent+1. Custom policies must pass `attemptNumber` explicitly when they do not mean “next attempt.”
- Do not export LLM internal metadata keys from core.

---

## HTTP Adapters

### KEEP

`FetchImplementation`, `CreateFetchOptions`.
`AxiosImplementation`, `CreateAxiosOptions`.
`UndiciImplementation`, `CreateUndiciOptions`.

Injection model: fetch defaults to `globalThis.fetch`; axios/undici require injection; no axios/undici peers. Freeze that.

Structural types are subsets, not feature-parity with the libraries. Freeze: no interceptors, no undici Dispatcher, no status classification.

### CHANGE BEFORE BETA

#### Caller cancellation (`createFetch`, `createAxios`, `createUndici` and their return types)

|                                     |                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**                         | `client.execute(op)` with **no** `ContextInit`. Request `signal` overwritten with `ctx.signal`. Tests assert the caller signal is **not** the transport signal and is not composed into the root context. |
| **Problem**                         | Fetch-shaped APIs are expected to honor `AbortSignal`. Timeout abort works; caller abort does not.                                                                                                        |
| **Direction (compatibility-first)** | **Keep existing argument shapes.** Pass the caller signal into `execute(op, { signal })` so it composes with timeout/policy signals. Transport continues to receive **composed** `ctx.signal`.            |
| **Alternatives rejected for beta**  | Extra options bag; forcing users onto `createClient`.                                                                                                                                                     |
| **Breaking?**                       | Behavior change. Signatures can stay. Anyone depending on ignored abort is not a real contract.                                                                                                           |
| **Cost now**                        | Medium (three adapters + tests + docs).                                                                                                                                                                   |
| **Cost after beta**                 | Abort UIs will be built on the adapter; fixing later is a silent behavior change in a frozen API.                                                                                                         |
| **Priority**                        | P0                                                                                                                                                                                                        |
| **Recommendation**                  | Compose existing `signal` fields. Do not add a parallel cancellation API.                                                                                                                                 |

#### Lifecycle (`ResilientFetch`, `ResilientAxios`, `ResilientUndici`)

Inner `Client` is unreachable: no `on`, no `destroy`. Axios is already a function object with methods — additive `on` / `destroy` fit. Fetch/undici return bare functions; attach the same methods (callable stays callable).

|                    |                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Direction**      | Additive `on` + `destroy` on all three return values.                                |
| **Breaking?**      | No if the function remains callable.                                                 |
| **Priority**       | P1                                                                                   |
| **Recommendation** | Do it in the same adapter pass as cancellation so freeze includes a complete handle. |

### REVIEW

`AxiosRequestConfig`, `AxiosResponse`, `UndiciRequestOptions`, `UndiciResponse` use `[key: string]: unknown` so injected clients type-check. That also hides misspellings. **Keep for beta** (injection ergonomics). Do not pretend these are complete library types.

`Create*Options` extend `ResiliConfig`, so they inherit the metrics hole and `deadlineMs` lie until core is fixed.

---

## @resili/llm

52 exports. No API Extractor.

### KEEP

**Client:** `createLlmClient`, `CreateLlmClientOptions`, `LlmClient`, `LlmGenerateRequest`, `LlmGenerateResult`.

Freeze `LlmGenerateRequest.input: string` (text-in/text-out). `signal` on the **request**, not on client options. `metadata` is `Record<string, string>` (stricter than core context metadata). `model` on client is a default; request may override.

**Provider:** `defineProvider`, `LlmProvider`, `LlmRequest`, `LlmResponse`, `LlmUsage`, `normalizeUsage`.

`LlmProvider.stream` optional; missing `stream` fails only when `LlmClient.stream()` is called. Freeze.

**Consumer stream:** `LlmStream`, `LlmStreamEvent`, `LlmStreamTextDelta`, `LlmStreamCompleted`, `LlmStreamResult`.

Freeze: pull-through; `result()` does not start execution; failures reject (no error event); commit after first non-empty `text-delta`; concurrent `next()` rejected.

**Pricing:** `createPricingResolver`, `ModelPricing`, `PricingResolver`, `PricingRate`, `calculateCost`, `LlmCost`, `USD_MICROS`, `TOKENS_PER_MILLION`, `usdToMicroUsd`, `microUsdToUsd`.

Unknown price → `undefined` cost, not `$0`. Freeze.

**Budget:** `BudgetGuardOptions`, `BudgetAccountant`, `createMemoryBudgetAccountant`, `BudgetScopeResolver`, `UnknownPricingBehavior`, `BudgetLimitKind`, `LlmBudgetExceededError`.

Process-local. `maxCostPerRequestUsd` is estimate-based. Freeze those limitations.

**Errors:** `LlmError`, `LlmErrorClassification` (12 names), `LlmErrorCode`, `isLlmError`, `isLlmErrorRetryable`.

`LlmError` extends `Error`, not `ResiliError`. Freeze the split.

**Observability:** `llmClassifier`, `LLM_METRIC_NAMES`, `LlmEvent*`, `LlmUnsubscribe`. `LlmClient.on` vs `onCore`. Freeze event names including `LlmStreamFailed.committed`.

Do **not** export `LLM_STREAM_COMMIT_STATE_KEY`, `LLM_REQUEST_METADATA_KEY`, `withStreamCommitRetryGuard`, `markLlmStreamCommitted`. They are correctly unexported.

### REVIEW

| Symbol                                                    | Problem                                                                                                                                     | Recommendation                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `LlmProviderStreamFrame`                                  | Comment says “not a public consumer event” but it is public because `LlmProvider.stream` returns it. Easy to confuse with `LlmStreamEvent`. | KEEP for adapter authors. Docs must say adapter-only. Do not rename (churn). |
| `LlmProviderIdentity`                                     | Only `{ name }`. `LlmProvider` already has `name`.                                                                                          | KEEP; too small to break.                                                    |
| `evaluateBudget`, `BudgetDecision`, `BudgetDecisionInput` | Useful for custom accountants; not needed by app developers.                                                                                | KEEP. Document as advanced.                                                  |
| `LlmFinishReason`                                         | Includes `tool_calls` though tools are not implemented.                                                                                     | KEEP as a reserved reason so adding tools later is not a break.              |

### CHANGE BEFORE BETA (llm)

None of the 52 names must be renamed. LLM inherits core CHANGE items via `CreateLlmClientOptions extends ResiliConfig`. Stream **behavior** is already freeze-worthy after alpha.4.

---

## Provider Adapters

### KEEP

| Package   | Keep                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| openai    | `createOpenAiProvider`, `CreateOpenAiProviderOptions`, `OpenAiClient`, `OpenAiRequestOptions`, `OpenAiErrorCause`                |
| anthropic | `createAnthropicProvider`, `CreateAnthropicProviderOptions`, `AnthropicClient`, `AnthropicRequestOptions`, `AnthropicErrorCause` |
| gemini    | `createGeminiProvider`, `CreateGeminiProviderOptions`, `GeminiClient`, `GeminiErrorCause`                                        |

Caller-owned clients. Optional peers. Retry disabled via constants (`0` / HTTP `attempts: 1`). First choice/candidate only. Chat Completions / Messages / `@google/genai` only.

**Structural SDK types** (`OpenAiChatCompletion*`, `AnthropicMessage*`, `GeminiGenerateContent*`, …): **KEEP**. They exist so `OpenAiClient` (etc.) can be public without importing the vendor package. They are **not** complete SDK typings. Expanding them to “full openai” is out of scope and would couple Resili to SDK minors.

**Retry constants** (`OPENAI_SDK_MAX_RETRIES`, `ANTHROPIC_SDK_MAX_RETRIES`, `GEMINI_SDK_HTTP_ATTEMPTS`): **KEEP**. They document the “Resili owns retries” contract and are useful in tests.

**Error cause types:** **KEEP**. Sanitized `status` / `code` / `type` / `requestID`. Consumers branch on them. Internalizing would force `unknown` causes.

### REVIEW

Peer ranges (`openai >=4`, `@anthropic-ai/sdk >=0.20`, `@google/genai >=1`) are packaging, not TS exports. Freeze as “minimum inspected”; do not silently widen public structural types when SDKs add fields.

Do **not** INTERNALIZE the structural types before beta: that is churn without a consumer-facing win, and it creates forgotten-export pressure.

---

## Config Type Honesty

| Field                                  | TypeScript                    | Runtime                                                        | Action                                    |
| -------------------------------------- | ----------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `timeout.deadlineMs`                   | optional number               | validated, **unused**                                          | **Reject** (throw) or **remove**          |
| `retry.jitter`                         | `"none" \| "full" \| "equal"` | only `"none"`                                                  | **Narrow** type                           |
| `retry.idempotentOnly`                 | `boolean`                     | must be `false`                                                | **Remove** from public type or keep throw |
| `rateLimiter.strategy`                 | token-bucket / sliding-window | both work                                                      | KEEP; **export** the union                |
| `rateLimiter.onLimit`                  | reject / wait                 | both work; `maxWaitMs` required for wait, forbidden for reject | KEEP                                      |
| `rateLimiter.burst`                    | optional                      | token-bucket only; throws on sliding-window                    | KEEP (throws — honest)                    |
| `cache.*`                              | key, ttl, flags, maxEntries   | matches                                                        | KEEP                                      |
| `dedupe.*`                             | key, abortSharedWhenUnused    | matches                                                        | KEEP                                      |
| `hedge.maxAttempts`                    | optional literal `2`          | other values throw                                             | KEEP                                      |
| `fallback.fallbackOn`                  | optional predicate            | default all errors                                             | KEEP                                      |
| `bulkhead.maxQueue` / `queueTimeoutMs` | optional                      | `0` default; timeout without queue throws                      | KEEP                                      |
| `circuitBreaker.failureRateThreshold`  | number                        | **percent** (50 = 50%)                                         | KEEP; docs already warn                   |
| `circuitBreaker.window`                | count \| time                 | both implemented                                               | KEEP; **export** `CircuitBreakerWindow`   |
| `ResiliConfig.metrics`                 | **absent**                    | plugin-only                                                    | **Add** field                             |
| HTTP `signal` on request objects       | present                       | overwritten, **not composed**                                  | **Compose** (behavior)                    |

Unknown `ResiliConfig` keys throw `ConfigurationError`. Keep that.

---

## Error Contracts

Freeze for beta (append-only):

**Core codes:** `ERR_CONFIG`, `ERR_CIRCUIT_OPEN`, `ERR_TIMEOUT`, `ERR_RETRY_EXCEEDED`, `ERR_BULKHEAD_FULL`, `ERR_RATE_LIMITED`, `ERR_ABORTED`.

**LLM classifications:** `authentication`, `authorization`, `invalid_request`, `rate_limited`, `timeout`, `provider_unavailable`, `overloaded`, `context_limit_exceeded`, `content_policy`, `network_transient`, `budget`, `unknown`.

Streaming:

- Pre-commit timeout exhaustion → `RetryExceededError`
- Post-commit timeout → `LlmError("timeout")` with `retryable: false`

`AbortError` and `name === "AbortError"` stay non-failure, non-retryable.

Do not merge `LlmError` into `ResiliError` before 1.0 (wide break).

---

## Forgotten exports

From `packages/core/etc/core.api.md` warnings. Public option types mention these; entrypoint does not export them.

| Symbol                                        | Used by                       | Action                                       |
| --------------------------------------------- | ----------------------------- | -------------------------------------------- |
| `ResiliErrorOptions`                          | error constructors            | Export or inline; prefer export              |
| `RetryBackoff`                                | `RetryOptions.backoff`        | Export                                       |
| `RetryJitter`                                 | `RetryOptions.jitter`         | Export **after** narrowing, or only `"none"` |
| `RateLimiterStrategy`                         | `RateLimiterOptions`          | Export                                       |
| `RateLimiterLimitBehavior`                    | `RateLimiterOptions`          | Export                                       |
| `CircuitBreakerWindow`                        | `CircuitBreakerOptions`       | Export                                       |
| `KeyResolver` (bulkhead, rate-limiter copies) | `key?: string \| KeyResolver` | Single shared export                         |

**Priority:** P1. Additive. Required for a clean API Extractor baseline.

---

## Breaking Changes Recommended Before Beta

Prefer few, high-value changes. No aesthetic churn (do not rename `LlmProviderStreamFrame`, do not merge error hierarchies).

### HIGH

1. **HTTP caller cancellation (behavior)**
   - **Current:** Caller `signal` ignored at the Resili layer.
   - **Proposed:** Compose it via `execute(..., { signal })`; keep call shapes.
   - **Why:** Advertised fetch/axios/undici shapes imply AbortSignal.
   - **Now vs later:** After beta, abort is part of the frozen HTTP contract.
   - **Impact:** Behavior fix; signatures stable.

2. **`timeout.deadlineMs` stop being a silent no-op**
   - **Current:** Optional, validated, unused.
   - **Proposed:** `ConfigurationError`.
   - **Why:** Fail loudly.
   - **Now vs later:** After beta, removing a public field is a break; throwing later surprises frozen configs.
   - **Impact:** Only callers of a field that never worked.

3. **`ClientStats` / `health()` honesty**
   - **Current:** Empty policy maps; health always healthy.
   - **Proposed:** Totals-only public type (preferred) or live maps.
   - **Why:** Readiness probes.
   - **Now vs later:** Freezing empty maps forever, or filling them later, both hurt.
   - **Impact:** Type break for unread empty maps.

### MEDIUM

4. **Narrow `RetryOptions` unimplemented fields.** Type-only. Avoids freezing `"full"` jitter as if it existed.

5. **`ResiliConfig.metrics` / `Builder.withMetrics`.** Additive. Closes a real hole. Do it while the freeze is open.

6. **HTTP `on` / `destroy`.** Additive on return values. Needed if plugins/events are supported on adapters.

### LOW

7. **Export forgotten core types.** Additive. Required for API Extractor cleanliness.

8. **`RESILI_VERSION` value.** Not a shape break.

**Do not break for beta:** pipeline order, streaming commit point, `LlmGenerateRequest.input: string`, `httpClassifier` 429-not-failure, process-local state, independent version lines, `LlmError` vs `ResiliError`, provider structural types, hedge `maxAttempts` literal `2`.

---

## API Baseline Strategy

| Package                 | Today         | Before beta                                     | Priority                         |
| ----------------------- | ------------- | ----------------------------------------------- | -------------------------------- |
| `@resili/core`          | API Extractor | Keep; zero forgotten-export warnings            | **P1** (P0 is the review itself) |
| `@resili/llm`           | none          | Add API Extractor report                        | **P1**                           |
| `@resili/llm-openai`    | none          | Add report (factory + options + cause + Client) | **P1**                           |
| `@resili/llm-anthropic` | none          | Same                                            | **P1**                           |
| `@resili/llm-gemini`    | none          | Same                                            | **P1**                           |
| `@resili/fetch`         | none          | Add report (4 exports)                          | **P1**                           |
| `@resili/axios`         | none          | Add report                                      | **P1**                           |
| `@resili/undici`        | none          | Add report                                      | **P1**                           |

LLM/HTTP reports are **P1**, not P0: the freeze _review_ is this document; the _tooling_ prevents regressions after freeze. Do not block HTTP cancellation on Extractor scaffolding.

Provider reports may omit verbose structural SDK types if Extractor cannot see them without exporting more — prefer listing them explicitly as KEEP structural subsets.

CI: `api:check` for core already; add llm + adapters in Milestone 6.

---

## Beta API Freeze Checklist

- [ ] Every exported symbol in this document classified (186)
- [ ] All CHANGE BEFORE BETA items implemented or explicitly deferred with a dated note
- [x] No silent no-op config fields (`timeout.deadlineMs` rejected or removed)
- [x] `RetryOptions` types match runtime
- [x] `stats()` / `health()` public type matches behavior
- [x] `RESILI_VERSION` is the real core version
- [x] `ResiliConfig` / `Builder` can inject `MetricsRecorder` (or freeze notes say plugin-only)
- [x] HTTP cancellation shape approved: compose existing `signal`; no extra bag
- [x] HTTP cancellation implemented and tested on fetch, axios, undici
- [ ] HTTP lifecycle (`on` / `destroy`) additive or explicitly out of freeze
- [ ] LLM `generate` / `stream` / `result()` / commit-point contract approved
- [ ] `LlmProvider` vs `LlmStreamEvent` vs `LlmProviderStreamFrame` documented
- [ ] Provider factories, peers, retry constants, error causes approved
- [ ] Structural SDK types documented as incomplete on purpose
- [ ] Public error taxonomy approved (core codes + 12 LLM classifications)
- [ ] Event maps approved (core closed map + 9 LLM events)
- [x] Forgotten core types exported; `api:check` clean
- [ ] API Extractor (or equivalent) agreed for llm + HTTP + providers
- [ ] Internal LLM commit/budget keys remain unexported
- [ ] Metadata shallow-reuse documented as a freeze invariant
- [ ] This review linked from `BETA_READINESS.md` / docs navigation (docs-only follow-up)

---

## Deferred API Questions

Not required to freeze beta. Do not expand scope.

| Question                                            | When                                   |
| --------------------------------------------------- | -------------------------------------- |
| Implement `retry.jitter` `"full"` / `"equal"`       | Post-beta                              |
| Implement `idempotentOnly`                          | Post-beta                              |
| Real overall timeout policy                         | 1.0                                    |
| Live `stats()` policy maps                          | 1.0 if totals-only for beta            |
| Merge `LlmError` into `ResiliError`                 | Never before 1.0 without a major       |
| Tools / `tool_calls` request API                    | Post-1.0; reason enum already reserved |
| OpenAI Responses API                                | Post-1.0                               |
| Rename `LlmProviderStreamFrame`                     | Do not                                 |
| Full vendor SDK types instead of structural subsets | Do not                                 |
| HTTP status-classification helpers                  | Post-beta                              |
| `AxiosRequestConfig` without index signature        | Post-beta, if ever                     |

---

## Core Beta Freeze Candidate

These `@resili/core` contracts are now considered safe to freeze for the remainder of Beta hardening.
HTTP lifecycle (`on` / `destroy`) is frozen as documented in [`BETA_HTTP_API_REVIEW.md`](./BETA_HTTP_API_REVIEW.md). LLM: [`BETA_LLM_API_REVIEW.md`](./BETA_LLM_API_REVIEW.md).

- `createClient` / `resili` / `Builder` including `withMetrics`
- `ResiliConfig` including `metrics`
- `TimeoutOptions.perAttemptMs` only; context `deadline` / `deadlineMs` for overall bounds
- `RetryOptions` with `jitter?: "none"` and implemented backoff/delay fields
- `Client.stats().totals` and `Client.health()` as a non-probe snapshot
- `RESILI_VERSION` matching `@resili/core` package.json
- Policy factories and option types with exported unions (`RetryBackoff`, `CircuitBreakerWindow`, rate-limiter strategy/behavior, shared `KeyResolver`)
- Error classes plus exported `ResiliErrorOptions`
- Canonical policy order (fallback → cache → retry → circuit → timeout → dedupe → hedge → rate limiter → bulkhead)

HTTP `on`/`destroy`: see `docs/releases/BETA_HTTP_API_REVIEW.md`. LLM/provider freeze: see `docs/releases/BETA_LLM_API_REVIEW.md`.

## Final Recommendation

Milestone 4 is the Core freeze candidate. Milestone 5 is the LLM/provider freeze candidate.
Milestone 6 is the HTTP freeze candidate plus the packed-consumer CI gate. Remaining Beta work is release-cut (versions, `--tag beta`, Gemini line alignment), not API invention.

---

## Audit trail

| Item                                             | Finding                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| Branch                                           | `main`                                              |
| HEAD                                             | `cf1f224d053cb1000541cfaa4727e7be3db3a5df`          |
| Public exports reviewed                          | 186                                                 |
| KEEP / REVIEW / CHANGE / INTERNALIZE / DEPRECATE | 157 / 15 / 14 / 0 / 0                               |
| Forgotten types                                  | 7                                                   |
| Core API Extractor                               | Present; no forgotten-export warnings (Milestone 4) |
| Other packages API Extractor                     | Absent                                              |
| HTTP cancellation API                            | Compose existing `signal` via `ContextInit`         |
| `ContextInit.deadlineMs`                         | Working (distinct from timeout policy)              |
