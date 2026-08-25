# Circuit breaker

Stops sending calls to a dependency that is failing, then probes it carefully before letting traffic
back.

**Pipeline position:** order `300` — inside retry, outside timeout.

## When to use it

When a dependency can be _down_, not merely flaky. Retry alone makes an outage worse by multiplying
load on a service that cannot answer. The breaker converts a slow cascade into a fast, cheap,
explicit failure.

## States

```text
closed ──── failure rate ≥ threshold ────▶ open
  ▲                                          │
  │                                     resetTimeoutMs elapses
  │                                          ▼
  └──── successThreshold probes pass ──── half_open
                                             │
                                        probe fails
                                             ▼
                                           open
```

- **`closed`** — calls pass through and outcomes are recorded in the window.
- **`open`** — calls fail immediately with `CircuitOpenError`. Nothing reaches the dependency.
- **`half_open`** — a limited number of probe calls are admitted. Enough successes close the circuit;
  a single failure or slow call reopens it.

## Configuration

```ts
interface CircuitBreakerOptions {
  readonly window?: { type: "count"; size: number } | { type: "time"; durationMs: number };
  readonly failureRateThreshold?: number;
  readonly slowCallDurationMs?: number;
  readonly slowCallRateThreshold?: number;
  readonly minimumThroughput?: number;
  readonly resetTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly successThreshold?: number;
  readonly key?: string | ((ctx: Context) => string);
}
```

| Option                  | Default                        | Notes                                                              |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `window`                | `{ type: "count", size: 100 }` | Count-based or time-based sample window.                           |
| `failureRateThreshold`  | `50`                           | **Percentage**, `50` = 50%. Not a `0..1` ratio.                    |
| `slowCallDurationMs`    | `0`                            | `0` disables slow-call tracking.                                   |
| `slowCallRateThreshold` | `100`                          | Percentage. Requires an explicit `slowCallDurationMs`.             |
| `minimumThroughput`     | `10`                           | Samples required before the breaker may open.                      |
| `resetTimeoutMs`        | `30_000`                       | How long `open` lasts before the first probe is allowed.           |
| `halfOpenMaxCalls`      | `1`                            | Concurrent probes permitted while half-open.                       |
| `successThreshold`      | `1`                            | Probe successes needed to close. Cannot exceed `halfOpenMaxCalls`. |
| `key`                   | `ctx.serviceName`              | Partition key. State is isolated per resolved key.                 |

`failureRateThreshold` is the option most often misconfigured. Passing `0.5` intending "50%" creates
a breaker that opens at half a percent.

Build-time validation also enforces that `minimumThroughput` does not exceed a count window's `size`,
and that `successThreshold` does not exceed `halfOpenMaxCalls`.

## Behavior

**Admission.** While closed, calls pass. While open, the breaker computes the remaining time to
`openedAt + resetTimeoutMs`; if any remains it throws `CircuitOpenError`, otherwise it transitions to
half-open and admits the call. While half-open, it admits up to `halfOpenMaxCalls` concurrent probes
and rejects the rest with `CircuitOpenError`.

**Recording.** Each completed call is judged on two axes: is it a _failure_
(`classifier.isFailure`), and is it _slow_ (`durationMs >= slowCallDurationMs`, only when that option
is non-zero).

**Opening.** While closed, once the window holds at least `minimumThroughput` samples, the breaker
opens if

```text
failureRate ≥ failureRateThreshold
  OR (slowCallDurationMs > 0 AND slowCallRate ≥ slowCallRateThreshold)
```

**Recovery.** In half-open, a failure or slow call reopens immediately. Successes accumulate until
`successThreshold` is met, then the circuit closes and the window resets.

Downstream errors are always rethrown unchanged; the breaker records the outcome but never wraps it.

## Errors

`CircuitOpenError` (`ERR_CIRCUIT_OPEN`) carries `key` and `retryAfterMs`. While open,
`retryAfterMs` is the time remaining until the first probe. When rejected because half-open probes
are saturated, it is the full `resetTimeoutMs`.

## What counts as a failure

The breaker delegates to the configured `FailureClassifier`, so this is tunable. Under the default
`httpClassifier`:

| Outcome                                                               | Counted as failure |
| --------------------------------------------------------------------- | ------------------ |
| Response with status 408, 500, 502, 503, 504                          | Yes                |
| Other 4xx responses                                                   | No                 |
| `TimeoutError`                                                        | Yes                |
| Network errors (`ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EPIPE`)   | Yes                |
| Generic `Error`                                                       | Yes                |
| `AbortError`                                                          | No                 |
| `CircuitOpenError`, `RateLimitExceededError`, `BulkheadRejectedError` | No                 |

Caller cancellations therefore do not push a healthy dependency toward open, and admission-control
rejections do not feed back into breaker state.

## AbortSignal

The breaker does not read or fork `ctx.signal`; it passes the context straight through.

## Interaction with other policies

- **Retry** is outside. `CircuitOpenError` is not retryable, so an open circuit ends the retry loop
  on the first attempt rather than consuming all attempts.
- **Timeout** is inside, so `TimeoutError` is recorded as a failure and can trip the breaker — which
  is usually what you want from a hanging dependency.
- **Fallback** is the outermost policy, so it can convert `CircuitOpenError` into a degraded
  response.

## Events

`CircuitOpened` (`key`, `failureRate`, `resetAt`), `CircuitHalfOpened` (`key`, `probesAllowed`),
`CircuitClosed` (`key`). No metrics are recorded.

## Example

```ts
import { CircuitOpenError, createClient } from "@resili/core";

const client = createClient(callPaymentsApi, {
  circuitBreaker: {
    window: { type: "count", size: 50 },
    minimumThroughput: 20,
    failureRateThreshold: 50, // percent
    resetTimeoutMs: 10_000,
    halfOpenMaxCalls: 2,
    successThreshold: 2,
    key: (ctx) => ctx.serviceName,
  },
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  fallback: (error) => (error instanceof CircuitOpenError ? cachedQuote() : Promise.reject(error)),
});
```

## Limitations

- State is in-memory and per client instance. Separate processes maintain separate breakers, so a
  dependency's health is learned independently by every replica.
- Half-open admission is counted, not queued: rejected probes fail fast rather than waiting.
- `retryAfterMs` on a half-open rejection reports `resetTimeoutMs`, not the true remaining wait.
- There is no manual `open()` / `close()` control surface.
