# Policies at a glance

Nine policies ship in `@resili/core`. All of them are public API. They are listed here in pipeline
order, outermost first.

| Policy                                | Config key       | Use it to                                         | State scope           |
| ------------------------------------- | ---------------- | ------------------------------------------------- | --------------------- |
| [Fallback](fallback.md)               | `fallback`       | Return an alternate value instead of throwing     | Stateless             |
| [Cache](cache.md)                     | `cache`          | Reuse a successful value for a TTL                | Per client, in-memory |
| [Retry](retry.md)                     | `retry`          | Re-attempt transient failures with backoff        | Per logical call      |
| [Circuit breaker](circuit-breaker.md) | `circuitBreaker` | Stop calling an unhealthy dependency              | Per client, per key   |
| [Timeout](timeout.md)                 | `timeout`        | Bound a single attempt                            | Per attempt           |
| [Dedupe](dedupe.md)                   | `dedupe`         | Share one in-flight execution across callers      | Per client, in-flight |
| [Hedge](hedge.md)                     | `hedge`          | Cut tail latency with a delayed duplicate attempt | Per logical call      |
| [Rate limiter](rate-limiter.md)       | `rateLimiter`    | Cap request rate                                  | Per client, per key   |
| [Bulkhead](bulkhead.md)               | `bulkhead`       | Cap concurrency and queue depth                   | Per client, per key   |

## Which policy solves which problem

| Symptom                                        | Reach for                             |
| ---------------------------------------------- | ------------------------------------- |
| Occasional 503s and connection resets          | [Retry](retry.md)                     |
| A dependency hangs and holds your event loop   | [Timeout](timeout.md)                 |
| A dead dependency is being hammered by retries | [Circuit breaker](circuit-breaker.md) |
| You are being throttled by an upstream API     | [Rate limiter](rate-limiter.md)       |
| One slow dependency starves everything else    | [Bulkhead](bulkhead.md)               |
| The same read happens over and over            | [Cache](cache.md)                     |
| The same read happens concurrently many times  | [Dedupe](dedupe.md)                   |
| p99 latency is far worse than p50              | [Hedge](hedge.md)                     |
| A degraded answer beats an error               | [Fallback](fallback.md)               |

## Defaults, at a glance

Only the values below are defaulted. Everything else must be supplied explicitly.

| Policy          | Defaulted options                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry           | `maxAttempts: 3`, `backoff: "exponential"`, `baseDelayMs: 100`, `maxDelayMs: 10_000`, `maxTotalDelayMs: 30_000`, `jitter: "none"`, `factor: 2`, `respectRetryAfter: true`                                                  |
| Timeout         | none — `perAttemptMs` is required                                                                                                                                                                                          |
| Circuit breaker | `window: { type: "count", size: 100 }`, `failureRateThreshold: 50`, `minimumThroughput: 10`, `resetTimeoutMs: 30_000`, `halfOpenMaxCalls: 1`, `successThreshold: 1`, `slowCallDurationMs: 0`, `slowCallRateThreshold: 100` |
| Rate limiter    | `strategy: "token-bucket"`, `onLimit: "reject"`, `burst: limit`                                                                                                                                                            |
| Bulkhead        | `maxQueue: 0`, `queueTimeoutMs: 0`                                                                                                                                                                                         |
| Cache           | `cacheUndefined: false`, `cacheNull: false`, `maxEntries: 1000`                                                                                                                                                            |
| Fallback        | none — `handler` is required                                                                                                                                                                                               |
| Dedupe          | `abortSharedWhenUnused: true`                                                                                                                                                                                              |
| Hedge           | `maxAttempts: 2`, `abortLosers: true`                                                                                                                                                                                      |

Where a policy has no default for a value, Resili raises a `ConfigurationError` at build time rather
than inventing one. Options are also validated eagerly, so a bad combination (for example
`queueTimeoutMs` without `maxQueue`) fails when you build the client, not on the first request.

## Errors raised by policies

| Error                    | Code                 | Raised by                                        |
| ------------------------ | -------------------- | ------------------------------------------------ |
| `ConfigurationError`     | `ERR_CONFIG`         | Any policy, at build time (or key resolution)    |
| `RetryExceededError`     | `ERR_RETRY_EXCEEDED` | Retry, when attempts or the delay budget run out |
| `TimeoutError`           | `ERR_TIMEOUT`        | Timeout                                          |
| `CircuitOpenError`       | `ERR_CIRCUIT_OPEN`   | Circuit breaker, while open or probe-saturated   |
| `RateLimitExceededError` | `ERR_RATE_LIMITED`   | Rate limiter                                     |
| `BulkheadRejectedError`  | `ERR_BULKHEAD_FULL`  | Bulkhead                                         |
| `AbortError`             | `ERR_ABORTED`        | Cancellation paths                               |

Full details in the [error reference](../reference/errors.md).

## Cross-policy notes

- **No policy wraps a downstream error it did not create.** A non-retryable failure comes back as the
  original error instance, not a Resili wrapper. The only exception is `RetryExceededError`, which
  carries the final failure on `lastError` (and as `cause`).
- **Retry re-enters every inner policy.** Each attempt passes through the circuit breaker, gets a
  fresh timeout timer, and re-acquires rate limiter and bulkhead permits.
- **A cache hit short-circuits everything below it**, including retry, timeout, and admission
  control.
- **Combining retry and hedge multiplies load.** Up to `retry attempts × 2` downstream calls are
  possible.
