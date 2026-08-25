# Configuration reference

Every configuration option, its type, and its default. For explanations of behavior, follow the links
to the per-policy pages.

All options are validated **eagerly** when the client is built. Anything invalid — or valid-looking
but not yet implemented — throws `ConfigurationError` synchronously, never at request time. Unknown
top-level keys are rejected rather than ignored.

## `ResiliConfig`

Accepted by `createClient(operation, config)` and, extended, by `createLlmClient`.

| Key              | Type                                                       | Default          |
| ---------------- | ---------------------------------------------------------- | ---------------- |
| `retry`          | `RetryOptions`                                             | not installed    |
| `timeout`        | `number \| TimeoutOptions`                                 | not installed    |
| `circuitBreaker` | `CircuitBreakerOptions`                                    | not installed    |
| `rateLimiter`    | `RateLimiterOptions`                                       | not installed    |
| `bulkhead`       | `number \| BulkheadOptions`                                | not installed    |
| `cache`          | `CacheOptions`                                             | not installed    |
| `fallback`       | `FallbackOptions \| FallbackFn`                            | not installed    |
| `dedupe`         | `DedupeOptions`                                            | not installed    |
| `hedge`          | `HedgeOptions`                                             | not installed    |
| `classifier`     | `FailureClassifier`                                        | `httpClassifier` |
| `clock`          | `Clock`                                                    | system clock     |
| `store`          | `StateStore`                                               | in-memory        |
| `policies`       | `readonly { factory: PolicyFactory; options?: unknown }[]` | `[]`             |

A policy is installed only when its key is present. There is no implicit retry, timeout, or breaker —
omitting a key means the behavior is absent, not defaulted on.

Shorthands: `timeout: 750` for `{ perAttemptMs: 750 }`, `bulkhead: 10` for `{ maxConcurrent: 10 }`,
`fallback: fn` for `{ handler: fn }`.

`store` accepts a custom `StateStore`, but no distributed implementation ships yet — the interface is
the seam, and the default is in-memory and per-process.

## Core policies

### `retry` → [Retry](../core/retry.md)

| Option              | Type                          | Default         | Notes                                                |
| ------------------- | ----------------------------- | --------------- | ---------------------------------------------------- |
| `maxAttempts`       | `number`                      | `3`             | Total attempts, not extra retries. `>= 1`            |
| `backoff`           | `"fixed" \| "exponential"`    | `"exponential"` |                                                      |
| `baseDelayMs`       | `number`                      | `100`           |                                                      |
| `maxDelayMs`        | `number`                      | `10_000`        | Per-delay cap                                        |
| `maxTotalDelayMs`   | `number`                      | `30_000`        | Cumulative delay budget across attempts              |
| `factor`            | `number`                      | `2`             | Exponential multiplier                               |
| `jitter`            | `"none" \| "full" \| "equal"` | `"none"`        | **Only `"none"` is implemented**                     |
| `respectRetryAfter` | `boolean`                     | `true`          | Honor a classifier delay hint over the backoff curve |
| `idempotentOnly`    | `boolean`                     | `false`         | **Must remain `false`** — not implemented            |
| `retryOn`           | `(outcome, ctx) => boolean`   | classifier      | Overrides the classifier for retry decisions only    |

`jitter: "full"` or `"equal"` and `idempotentOnly: true` throw `ConfigurationError`. They are in the
type to reserve the shape, and rejecting them is deliberate: silently ignoring a jitter setting you
believe is active would be worse than failing.

### `timeout` → [Timeout](../core/timeout.md)

| Option         | Type     | Default    | Notes                                              |
| -------------- | -------- | ---------- | -------------------------------------------------- |
| `perAttemptMs` | `number` | _required_ | Applies to each attempt independently              |
| `deadlineMs`   | `number` | —          | Validated, but **not enforced** as a runtime limit |

A total-deadline timeout is not implemented. With `maxAttempts: 3` and `perAttemptMs: 1000`, worst-case
wall time is roughly three seconds plus backoff — there is no single ceiling.

### `circuitBreaker` → [Circuit breaker](../core/circuit-breaker.md)

| Option                  | Type                                                                      | Default                        |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| `window`                | `{ type: "count"; size: number } \| { type: "time"; durationMs: number }` | `{ type: "count", size: 100 }` |
| `failureRateThreshold`  | `number`                                                                  | `50`                           |
| `slowCallDurationMs`    | `number`                                                                  | `0` (disabled)                 |
| `slowCallRateThreshold` | `number`                                                                  | `100`                          |
| `minimumThroughput`     | `number`                                                                  | `10`                           |
| `resetTimeoutMs`        | `number`                                                                  | `30_000`                       |
| `halfOpenMaxCalls`      | `number`                                                                  | `1`                            |
| `successThreshold`      | `number`                                                                  | `1`                            |
| `key`                   | `string \| ((ctx) => string)`                                             | one shared circuit             |

Thresholds are **percentages** (`50` means 50%), not fractions. `failureRateThreshold: 0.5` would
mean half a percent and open the breaker almost immediately.

`minimumThroughput` prevents a single early failure from opening the breaker on a cold window.

### `rateLimiter` → [Rate limiter](../core/rate-limiter.md)

| Option       | Type                                 | Default            |
| ------------ | ------------------------------------ | ------------------ |
| `limit`      | `number`                             | _required_         |
| `intervalMs` | `number`                             | _required_         |
| `strategy`   | `"token-bucket" \| "sliding-window"` | `"token-bucket"`   |
| `burst`      | `number`                             | `limit`            |
| `onLimit`    | `"reject" \| "wait"`                 | `"reject"`         |
| `maxWaitMs`  | `number`                             | see below          |
| `key`        | `string \| ((ctx) => string)`        | one shared limiter |

`maxWaitMs` has no default — it is **required** when `onLimit: "wait"` and **rejected** when
`onLimit: "reject"`. Both mismatches throw `ConfigurationError`, so a wait budget can never be
silently ignored or silently applied.

`burst` is supported only for `token-bucket`; passing it with `sliding-window` throws.

### `bulkhead` → [Bulkhead](../core/bulkhead.md)

| Option           | Type                          | Default             |
| ---------------- | ----------------------------- | ------------------- |
| `maxConcurrent`  | `number`                      | _required_          |
| `maxQueue`       | `number`                      | `0`                 |
| `queueTimeoutMs` | `number`                      | `0`                 |
| `key`            | `string \| ((ctx) => string)` | one shared bulkhead |

`maxQueue: 0` means no queuing: excess requests are rejected immediately. `queueTimeoutMs > 0` with
`maxQueue: 0` throws — a queue timeout without a queue is a configuration mistake, not a no-op.

### `cache` → [Cache](../core/cache.md)

| Option           | Type                     | Default    |
| ---------------- | ------------------------ | ---------- |
| `key`            | `(...args) => DedupeKey` | _required_ |
| `ttl`            | `number`                 | _required_ |
| `maxEntries`     | `number`                 | `1_000`    |
| `cacheUndefined` | `boolean`                | `false`    |
| `cacheNull`      | `boolean`                | `false`    |

`key` receives the call arguments, so it must be pure and stable. Only successful results are cached;
errors never are.

### `fallback` → [Fallback](../core/fallback.md)

| Option       | Type                              | Default    |
| ------------ | --------------------------------- | ---------- |
| `handler`    | `(error, ctx) => R \| Promise<R>` | _required_ |
| `fallbackOn` | `(error, ctx) => boolean`         | all errors |

`fallbackOn` must return `false` explicitly to let an error through. Being outermost, fallback catches
`RetryExceededError`, `CircuitOpenError`, and admission rejections too.

### `dedupe` → [Dedupe](../core/dedupe.md)

| Option                  | Type                     | Default    |
| ----------------------- | ------------------------ | ---------- |
| `key`                   | `(...args) => DedupeKey` | _required_ |
| `abortSharedWhenUnused` | `boolean`                | `true`     |

### `hedge` → [Hedge](../core/hedge.md)

| Option         | Type                      | Default    |
| -------------- | ------------------------- | ---------- |
| `delay`        | `number`                  | _required_ |
| `maxAttempts`  | `2`                       | `2`        |
| `abortLosers`  | `boolean`                 | `true`     |
| `shouldAccept` | `(value, ctx) => boolean` | accept all |

`maxAttempts` is typed as the literal `2`; any other value throws. Hedging multiplies load, so combine
it with retry only deliberately.

## Per-call options

`client.execute(operation, options)` and the LLM request objects accept:

| Option     | Type                      | Notes                                                   |
| ---------- | ------------------------- | ------------------------------------------------------- |
| `signal`   | `AbortSignal`             | Composed with policy-internal signals                   |
| `metadata` | `Record<string, unknown>` | Available to key resolvers, classifiers, and predicates |

`metadata.idempotent === true` is the signal the default classifier requires before it will retry an
ambiguous network error (`ECONNRESET` and friends). Without it, such errors are failures but not
retryable. → [Error classification](../architecture/error-classification.md#network-errors-and-idempotency)

Metadata **values** are shared by reference across retry and timeout context forks, so a mutable
object placed there is visible to every attempt.
→ [Execution context](../core/execution-context.md#metadata-values-are-shared-across-forks)

## HTTP adapters

All three accept every `ResiliConfig` key plus one required injection or implementation override.

| Adapter          | Extra options                                      | → docs                      |
| ---------------- | -------------------------------------------------- | --------------------------- |
| `@resili/fetch`  | `fetch?: FetchImplementation` (defaults to global) | [fetch](../http/fetch.md)   |
| `@resili/axios`  | `axios: AxiosImplementation` (**required**)        | [axios](../http/axios.md)   |
| `@resili/undici` | `request: UndiciImplementation` (**required**)     | [undici](../http/undici.md) |

Two things to keep in mind:

- Adapters **overwrite** the signal on your request arguments with the Resili context signal, and
  expose no per-call options, so caller-initiated cancellation is not supported through them. Only
  timeout-driven cancellation works.
  → [HTTP overview](../http/overview.md#cancellation-and-the-signal-you-cannot-pass)
- HTTP status codes are **not** classified by default. A 503 is a returned value, not an error. Use
  `retry.retryOn` to opt in. → [HTTP overview](../http/overview.md#status-codes-are-not-classified-by-default)

## `createLlmClient`

Extends `ResiliConfig<LlmResponse>` with:

| Key        | Type                 | Default                    |
| ---------- | -------------------- | -------------------------- |
| `provider` | `LlmProvider`        | _required_                 |
| `model`    | `string`             | per-request only           |
| `pricing`  | `PricingResolver`    | none — cost is `undefined` |
| `budget`   | `BudgetGuardOptions` | not installed              |
| `metrics`  | `MetricsRecorder`    | `noopMetrics`              |

`model` here is a default; a request may override it. Without `pricing`, usage is still tracked but
cost is not computed, and Budget Guard cannot evaluate limits.

The classifier defaults to `llmClassifier`, and whatever you supply is wrapped with the
[stream commit guard](../architecture/error-classification.md#the-stream-commit-guard).

`metadata` is a **per-request** option, not a client option — passing it to `createLlmClient` throws
`ConfigurationError`.

### `budget` → [Budget Guard](../llm/budget-guard.md)

| Option                  | Type                          | Default    |
| ----------------------- | ----------------------------- | ---------- |
| `maxCostPerRequestUsd`  | `number`                      | no limit   |
| `maxAccumulatedCostUsd` | `number`                      | no limit   |
| `scope`                 | `string \| ((req) => string)` | `provider` |
| `warningThresholdRatio` | `number`                      | `0.8`      |
| `onUnknownPricing`      | `"allow" \| "reject"`         | `"reject"` |
| `accountant`            | `BudgetAccountant`            | in-memory  |

`maxCostPerRequestUsd` is compared against the **estimate**, so actual cost can exceed it when output
tokens run past `estimatedOutputTokens`. It is a guard, not a hard ceiling.

`onUnknownPricing: "reject"` defaults to failing closed — an unpriced model would otherwise bypass
budget control entirely.

Accounting is **process-local**. Multiple instances or replicas each track their own totals.

### LLM request options → [generate](../llm/generate.md) · [streaming](../llm/streaming.md)

| Option                  | Type                     | Notes                                        |
| ----------------------- | ------------------------ | -------------------------------------------- |
| `input`                 | `string`                 | Prompt text; the adapter shapes the SDK call |
| `model`                 | `string`                 | Overrides the client default                 |
| `estimatedInputTokens`  | `number`                 | Budget Guard preflight only                  |
| `estimatedOutputTokens` | `number`                 | Budget Guard preflight only                  |
| `metadata`              | `Record<string, string>` | Scope resolution, keys, classification       |
| `signal`                | `AbortSignal`            | Caller cancellation                          |

LLM request `metadata` is string-valued, unlike core's `Context.metadata`, which accepts `unknown`.

Estimates affect only budget preflight — they never change the request sent to the provider.

## Validated but not implemented

Configuration that is accepted by the types and rejected at build time, so nothing silently does
nothing:

| Option                             | Behavior                           |
| ---------------------------------- | ---------------------------------- |
| `retry.jitter: "full" \| "equal"`  | Throws `ConfigurationError`        |
| `retry.idempotentOnly: true`       | Throws `ConfigurationError`        |
| `timeout.deadlineMs`               | Validated; not enforced at runtime |
| `hedge.maxAttempts` other than `2` | Throws `ConfigurationError`        |

Also absent: distributed policy state (`StateStore` is the seam, no implementation ships), separate
time-to-first-token or idle-chunk timeouts for streaming
([timeouts](../llm/timeouts.md#what-is-not-implemented)), and any built-in telemetry
exporter.
