# Error reference

A lookup table for every public error. For guidance on handling them, see
[Error classification](../architecture/error-classification.md) and [LLM errors](../llm/errors.md).

## Two hierarchies

```text
Error
├── ResiliError                 @resili/core   — abstract, code + isResili marker
│   ├── ConfigurationError        ERR_CONFIG
│   ├── CircuitOpenError          ERR_CIRCUIT_OPEN
│   ├── TimeoutError              ERR_TIMEOUT
│   ├── RetryExceededError        ERR_RETRY_EXCEEDED
│   ├── BulkheadRejectedError     ERR_BULKHEAD_FULL
│   ├── RateLimitExceededError    ERR_RATE_LIMITED
│   └── AbortError                ERR_ABORTED
│
└── LlmError                    @resili/llm    — classification + isResiliLlm marker
    └── LlmBudgetExceededError     ERR_LLM_BUDGET
```

`LlmError` extends `Error` directly, not `ResiliError`. A call through an LLM client can therefore
throw from either hierarchy, and `isResiliError()` returns `false` for an `LlmError`.

Both hierarchies expose a stable `code` string and a brand property, and both preserve the original
failure on `cause`.

## Cross-realm guards

```ts
import { isResiliError } from "@resili/core";
import { isLlmError } from "@resili/llm";
```

Prefer these over `instanceof` across package boundaries. They check the brand property and validate
`code` against the known set, so they work even when two copies of a package are loaded — a real
possibility in a monorepo or with mismatched transitive versions.

## Core errors

Every core error carries `code`, `isResili === true`, an optional `context` snapshot, and `cause`.

### `ConfigurationError` — `ERR_CONFIG`

| Field   | Type                  |
| ------- | --------------------- |
| `field` | `string \| undefined` |

Thrown **synchronously at build time** from `createClient`, `.build()`, `createLlmClient`, or a
policy factory. Misconfiguration never reaches a request. Also used for options that are validated
but not yet implemented — `retry.jitter` other than `"none"`, `retry.idempotentOnly`,
`timeout.deadlineMs` as a runtime limit.

### `CircuitOpenError` — `ERR_CIRCUIT_OPEN`

| Field          | Type     | Meaning                           |
| -------------- | -------- | --------------------------------- |
| `key`          | `string` | Breaker partition that rejected   |
| `retryAfterMs` | `number` | Until the next probe may be tried |

Thrown before the operation runs. **Not a failure, not retryable** — counting the breaker's own
rejections would prevent recovery. → [Circuit breaker](../core/circuit-breaker.md)

### `TimeoutError` — `ERR_TIMEOUT`

| Field           | Type                  | Meaning                        |
| --------------- | --------------------- | ------------------------------ |
| `timeoutMs`     | `number`              | Configured `perAttemptMs`      |
| `attemptNumber` | `number \| undefined` | 1-based attempt that timed out |

Per-attempt, not per-request. A failure _and_ retryable by default. Distinct from `AbortError`
because a timeout means the dependency is slow, while an abort means the caller left.
→ [Timeout](../core/timeout.md)

### `RetryExceededError` — `ERR_RETRY_EXCEEDED`

| Field       | Type      | Meaning                    |
| ----------- | --------- | -------------------------- |
| `attempts`  | `number`  | Attempts executed          |
| `lastError` | `unknown` | The final underlying error |

The only core error that wraps. `cause` is set to the same value as `lastError`, so both work.

It is thrown **only when retries were exhausted while the error was still retryable**. A
non-retryable error propagates unchanged, which means seeing `RetryExceededError` tells you the
failure was transient-looking and Resili genuinely gave up.

```ts
catch (error) {
  if (error instanceof RetryExceededError) {
    log.warn({ attempts: error.attempts }, "gave up");
    throw error.lastError;
  }
  throw error;
}
```

→ [Retry](../core/retry.md)

### `BulkheadRejectedError` — `ERR_BULKHEAD_FULL`

| Field           | Type     | Meaning                                            |
| --------------- | -------- | -------------------------------------------------- |
| `maxConcurrent` | `number` | Configured concurrency limit                       |
| `queueSize`     | `number` | Queue depth at rejection                           |
| `waitedMs`      | `number` | Time queued before rejection (`0` if never queued) |

**Not a failure, retryable.** Local saturation is not a downstream outage.
→ [Bulkhead](../core/bulkhead.md)

### `RateLimitExceededError` — `ERR_RATE_LIMITED`

| Field          | Type     | Meaning                    |
| -------------- | -------- | -------------------------- |
| `retryAfterMs` | `number` | Until capacity is expected |

Thrown when `onLimit: "reject"` denies admission, or `onLimit: "wait"` would exceed `maxWaitMs`.
**Not a failure, retryable**, and the default classifier feeds `retryAfterMs` to retry as a delay
hint. → [Rate limiter](../core/rate-limiter.md)

### `AbortError` — `ERR_ABORTED`

| Field    | Type      | Meaning               |
| -------- | --------- | --------------------- |
| `reason` | `unknown` | Original abort reason |

**Neither a failure nor retryable.** Cancellation is caller intent, so it must not open a breaker or
trigger a retry. The default classifier also treats any error whose `name` is `"AbortError"` this way,
which covers the DOM/SDK aborts thrown by `fetch` and the vendor SDKs.
→ [Cancellation](../core/cancellation.md)

## LLM errors

`LlmError` fields: `code`, `classification`, `retryable`, `isResiliLlm`, and optional `retryAfterMs`,
`provider`, `model`. `name` is `"LlmError"`.

Adapters map SDK errors to a classification; `retryable` is then derived from it unless explicitly
overridden.

| Classification           | Code                      | Retryable by default |
| ------------------------ | ------------------------- | -------------------- |
| `authentication`         | `ERR_LLM_AUTH`            | No                   |
| `authorization`          | `ERR_LLM_FORBIDDEN`       | No                   |
| `invalid_request`        | `ERR_LLM_INVALID_REQUEST` | No                   |
| `rate_limited`           | `ERR_LLM_RATE_LIMITED`    | **Yes**              |
| `timeout`                | `ERR_LLM_TIMEOUT`         | **Yes**              |
| `provider_unavailable`   | `ERR_LLM_UNAVAILABLE`     | **Yes**              |
| `overloaded`             | `ERR_LLM_OVERLOADED`      | **Yes**              |
| `context_limit_exceeded` | `ERR_LLM_CONTEXT_LIMIT`   | No                   |
| `content_policy`         | `ERR_LLM_CONTENT_POLICY`  | No                   |
| `network_transient`      | `ERR_LLM_NETWORK`         | **Yes**              |
| `budget`                 | `ERR_LLM_BUDGET`          | No                   |
| `unknown`                | `ERR_LLM_UNKNOWN`         | No                   |

`unknown` is not retryable on purpose: an unrecognized error may be permanent, and retrying blindly
risks amplifying an outage.

`retryable` is a per-instance field, not a fixed property of the classification. A provider adapter
can construct `new LlmError("timeout", { retryable: false })` — which is exactly what the streaming
layer does for a post-commit timeout.

### `LlmBudgetExceededError` — `ERR_LLM_BUDGET`

Extends `LlmError` with `classification: "budget"`, `retryable: false`, `name`
`"LlmBudgetExceededError"`.

| Field                 | Type                                                  | Meaning                   |
| --------------------- | ----------------------------------------------------- | ------------------------- |
| `scope`               | `string`                                              | Budget scope key          |
| `limitMicroUsd`       | `number`                                              | Limit exceeded, micro-USD |
| `accumulatedMicroUsd` | `number`                                              | Prior spend for the scope |
| `attemptedMicroUsd`   | `number`                                              | Cost that would be added  |
| `limitKind`           | `"per-request" \| "accumulated" \| "unknown-pricing"` | Which limit fired         |

Thrown before the provider is called, so no tokens are spent. Because Budget Guard sits **before**
retry, it is not retried. → [Budget Guard](../llm/budget-guard.md)

## Streaming: pre-commit versus post-commit

The most important distinction in the error model. A stream is _committed_ once the first non-empty
text delta has been delivered to the consumer.

| Failure                                      | Error the consumer sees                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Timeout **before** commit, retries left      | Retried; no error surfaces                                                |
| Timeout **before** commit, retries exhausted | `RetryExceededError` with `lastError` a `TimeoutError`                    |
| Timeout **after** commit                     | `LlmError("timeout")` with `retryable: false`, `cause` the `TimeoutError` |

After commit, a retry would concatenate two generations into one corrupt answer, so no new provider
generation is started and the error is normalized to a terminal one. Before commit nothing has been
observed, so retrying is safe and the standard exhaustion error is preserved.

```ts
try {
  for await (const event of stream) {
    /* ... */
  }
} catch (error) {
  if (error instanceof RetryExceededError) {
    // never produced output — safe to retry the whole request
  } else if (isLlmError(error) && error.classification === "timeout" && !error.retryable) {
    // partial output already delivered — do not silently re-run
  }
}
```

→ [Streaming](../llm/streaming.md#the-commit-point)

## Codes at a glance

| Code                 | Error                    | Failure | Retryable          |
| -------------------- | ------------------------ | ------- | ------------------ |
| `ERR_CONFIG`         | `ConfigurationError`     | —       | —                  |
| `ERR_CIRCUIT_OPEN`   | `CircuitOpenError`       | No      | No                 |
| `ERR_TIMEOUT`        | `TimeoutError`           | Yes     | Yes                |
| `ERR_RETRY_EXCEEDED` | `RetryExceededError`     | Yes     | No                 |
| `ERR_BULKHEAD_FULL`  | `BulkheadRejectedError`  | No      | Yes                |
| `ERR_RATE_LIMITED`   | `RateLimitExceededError` | No      | Yes                |
| `ERR_ABORTED`        | `AbortError`             | No      | No                 |
| `ERR_LLM_*`          | `LlmError`               | Yes     | Per classification |
| `ERR_LLM_BUDGET`     | `LlmBudgetExceededError` | Yes     | No                 |

"Failure" and "Retryable" describe the default classifiers and are configurable — except the
post-commit streaming guard, which always wins.

## Privacy

Error messages and `cause` chains never contain prompts, generated text, API keys, or `Authorization`
headers. Adapters build a redacted summary of the SDK error — status, provider error type, message
text — rather than attaching the raw response.

Never log an entire caught error object without review: your own operation's errors are outside
Resili's control. → [Telemetry](../observability/telemetry.md)
