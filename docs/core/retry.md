# Retry

Re-runs the wrapped work when the outcome is classified as retryable, with bounded attempts and
bounded total delay.

**Pipeline position:** order `200` — outside the circuit breaker and timeout, inside cache and
fallback.

## When to use it

Use retry for failures that are likely to succeed on a second try: connection resets, 503s, 429s,
per-attempt timeouts. Do **not** use it for operations that are unsafe to repeat unless you can make
them idempotent — Resili cannot know whether your `POST` created a record before it failed.

## Configuration

```ts
interface RetryOptions {
  readonly maxAttempts?: number;
  readonly backoff?: "fixed" | "exponential";
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxTotalDelayMs?: number;
  readonly jitter?: "none" | "full" | "equal";
  readonly factor?: number;
  readonly retryOn?: (outcome: Outcome, ctx: Context) => boolean;
  readonly respectRetryAfter?: boolean;
  readonly idempotentOnly?: boolean;
}
```

| Option              | Default         | Notes                                                                |
| ------------------- | --------------- | -------------------------------------------------------------------- |
| `maxAttempts`       | `3`             | **Total** attempts, including the first. Must be an integer `>= 1`.  |
| `backoff`           | `"exponential"` | `"fixed"` or `"exponential"`.                                        |
| `baseDelayMs`       | `100`           | First delay, and the constant delay when `backoff: "fixed"`.         |
| `maxDelayMs`        | `10_000`        | Per-delay ceiling. Must be `>= baseDelayMs`.                         |
| `maxTotalDelayMs`   | `30_000`        | Budget across all delays in one logical call.                        |
| `jitter`            | `"none"`        | Only `"none"` is implemented — see below.                            |
| `factor`            | `2`             | Exponential multiplier. Rejected when `backoff: "fixed"`.            |
| `retryOn`           | —               | Overrides the classifier entirely when supplied.                     |
| `respectRetryAfter` | `true`          | Honor a classifier-supplied retry-after hint over the backoff curve. |
| `idempotentOnly`    | `false`         | Not implemented — see below.                                         |

### Options that are validated but not yet implemented

Two values are deliberately rejected at build time rather than silently ignored:

- `jitter: "full"` and `jitter: "equal"` throw `ConfigurationError`. Randomized jitter is withheld
  until deterministic randomization is injectable, so tests stay reproducible. Use
  `jitter: "none"`.
- `idempotentOnly: true` throws `ConfigurationError`.

## Behavior

1. The first attempt runs on the incoming context. Every later attempt runs on
   `ctx.fork({ attemptNumber })`, so `ctx.attemptNumber` is accurate inside the operation.
2. The outcome is classified. `retryOn` wins if supplied; otherwise
   `classifier.isRetryable(outcome, ctx)` decides.
3. A non-retryable failure is **rethrown unchanged** — the original error instance, not a wrapper.
4. Otherwise the next delay is computed, checked against `maxTotalDelayMs`, and slept through using
   the injected `Clock`.
5. When attempts or the delay budget are exhausted, retry throws `RetryExceededError`.

`retryOn` can also request a retry for a _successful_ outcome — useful for treating a 503 response
object as retryable without throwing.

### Delay curve

```text
exponential:  delay(n) = min(maxDelayMs, baseDelayMs × factor ** n)     n = 0 for the first retry
fixed:        delay(n) = min(maxDelayMs, baseDelayMs)
```

With defaults, delays are 100 ms, 200 ms, 400 ms, … capped at 10 s, with a 30 s total budget.

When `respectRetryAfter` is `true` and the classifier reports a retry-after hint for the outcome
(from an HTTP `Retry-After` header, a `RateLimitExceededError`, or a `CircuitOpenError`), that value
is used instead of the curve, clamped to `[0, maxDelayMs]`.

## Errors

`RetryExceededError` (`ERR_RETRY_EXCEEDED`) carries:

| Property    | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `attempts`  | How many attempts were made                        |
| `lastError` | The final underlying failure (also set as `cause`) |
| `context`   | A snapshot of the root context                     |

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";

try {
  await client.call("42");
} catch (error) {
  if (error instanceof RetryExceededError) {
    console.error(`gave up after ${error.attempts}`, error.lastError);
    if (error.lastError instanceof TimeoutError) {
      // every attempt timed out
    }
  }
}
```

Note the asymmetry: exhausting retries produces `RetryExceededError`, but a failure the classifier
calls non-retryable propagates as-is on the first attempt.

## AbortSignal

The retry policy does not inspect `ctx.signal` itself. Cancellation reaches it through the
classifier: the default `httpClassifier` treats `AbortError` as **neither a failure nor retryable**,
so an aborted attempt stops the loop immediately and the abort error propagates. Retry does not
check the signal _during_ a backoff sleep, so a caller abort mid-delay is observed when the next
attempt starts rather than interrupting the timer.

## Interaction with other policies

- **Timeout** is inside retry, so every attempt gets a fresh `perAttemptMs` timer, and `TimeoutError`
  is retryable under the default classifier. See [Timeout](timeout.md).
- **Circuit breaker** is inside retry. `CircuitOpenError` is not retryable, so an open circuit ends
  the retry loop immediately instead of burning attempts.
- **Rate limiter** and **bulkhead** are inside retry, so each attempt re-acquires a permit.
- **Cache** is outside retry: a hit means retry never runs.
- **Hedge** is inside retry, so the two multiply — up to `maxAttempts × 2` downstream calls.

## Events

`RetryStarted` (`attemptNumber`, `delayMs`, `reason?`), `RetryCompleted` (`attempts`,
`totalDelayMs`), and `RetryFailed` (`attempts`, `lastErrorCode?`). `RetryCompleted` is emitted only
when at least one retry happened. Retry records no metrics.

## Example

```ts
import { createClient } from "@resili/core";

const client = createClient(chargeCard, {
  retry: {
    maxAttempts: 4,
    backoff: "exponential",
    baseDelayMs: 200,
    maxDelayMs: 5_000,
    maxTotalDelayMs: 15_000,
    jitter: "none",
    retryOn: (outcome) => outcome.status === "error" && isTransient(outcome.error),
  },
  timeout: { perAttemptMs: 2_000 },
});
```

## Limitations

- Randomized jitter is not available; concurrent clients retrying on the same schedule can
  synchronize into bursts.
- `maxTotalDelayMs` is a _delay_ budget, not a wall-clock deadline — it does not count time spent
  executing attempts. Use `Context.deadline` for an end-to-end bound.
- The delay budget can end the loop before any sleep occurs if the first computed delay already
  exceeds it.
- Retry has no notion of idempotency; `idempotentOnly` is not implemented.
