# Rate limiter

Caps how often the wrapped work may run, either rejecting excess calls or making them wait.

**Pipeline position:** order `500` — inside timeout, hedge, and dedupe; outside the bulkhead.

## When to use it

To stay inside a quota you do not control (a vendor API's requests-per-second) or to protect a
downstream you do control from a traffic spike. Rate limiting bounds _arrival rate_; use a
[bulkhead](bulkhead.md) to bound _concurrency_.

## Configuration

```ts
interface RateLimiterOptions {
  readonly strategy?: "token-bucket" | "sliding-window";
  readonly limit: number;
  readonly intervalMs: number;
  readonly burst?: number;
  readonly onLimit?: "reject" | "wait";
  readonly maxWaitMs?: number;
  readonly key?: string | ((ctx: Context) => string);
}
```

| Option       | Default           | Notes                                                              |
| ------------ | ----------------- | ------------------------------------------------------------------ |
| `strategy`   | `"token-bucket"`  | Two algorithms are implemented; see below.                         |
| `limit`      | required          | Permits per `intervalMs`. Integer `>= 1`.                          |
| `intervalMs` | required          | Window length in milliseconds, `> 0`.                              |
| `burst`      | `limit`           | Token-bucket capacity. **Rejected for `sliding-window`.**          |
| `onLimit`    | `"reject"`        | Behavior when no permit is available.                              |
| `maxWaitMs`  | —                 | **Required** when `onLimit: "wait"`; **rejected** when `"reject"`. |
| `key`        | `ctx.serviceName` | Partition key. Buckets and windows are isolated per resolved key.  |

## Algorithms

Both are implemented; there is no fixed-window mode.

**`token-bucket` (default).** A bucket refills continuously at `limit / intervalMs` tokens per
millisecond, capped at `burst`. A new bucket starts full. Each admitted call consumes one token. This
smooths a steady rate while tolerating a burst up to `burst`.

**`sliding-window`.** Admission timestamps are kept per key; entries older than `intervalMs` are
dropped, and a call is admitted while fewer than `limit` remain. This enforces "no more than `limit`
in any rolling window" strictly, with no burst allowance — which is why `burst` is rejected here.

## `onLimit` behavior

**`"reject"` (default).** One acquisition attempt. If it fails, `RateLimitExceededError` is thrown
immediately with a `retryAfterMs` hint, and `RateLimited` is emitted with `waited: false`.

**`"wait"`.** Requires `maxWaitMs`. Waiters for the same key queue in FIFO order. The policy loops:
check for cancellation, try to acquire, and if the computed `retryAfterMs` exceeds the remaining wait
budget, throw `RateLimitExceededError`; otherwise sleep for `retryAfterMs` via the injected `Clock`
and try again.

Waiting turns a throughput limit into added latency. That latency is inside your
[timeout](timeout.md), so `maxWaitMs` should be comfortably smaller than `perAttemptMs` or the
attempt will time out while queued.

## Errors

`RateLimitExceededError` (`ERR_RATE_LIMITED`) carries `retryAfterMs`. The default classifier treats
it as **retryable but not a failure** — it does not count toward opening a circuit breaker — and the
retry policy will use its `retryAfterMs` as the backoff delay when `respectRetryAfter` is enabled.

In wait mode, a cancellation during the wait rejects with the signal's reason if it is an `Error`,
otherwise with `AbortError`.

## AbortSignal

- **Wait mode** is fully cancellable: the signal is checked on every loop iteration, the sleep timer
  is cleared on abort, and an aborted waiter does **not** consume a token. The next caller can
  proceed normally.
- **Reject mode** does not consult the signal; the acquisition attempt is synchronous and immediate.

## Interaction with other policies

- **Retry** is outside, so each attempt re-acquires a permit. Combining `onLimit: "reject"` with
  retry gives you a rate limiter that backs off using the error's own `retryAfterMs`.
- **Timeout** is outside, so wait-mode latency counts against `perAttemptMs`.
- **Dedupe** is outside: callers that join an in-flight execution do not consume separate permits.
- **Bulkhead** is inside, so a call that passes the rate limiter can still be rejected on
  concurrency.

## Events

`RateLimited` with `key`, `strategy`, `retryAfterMs`, and `waited`. In wait mode the event may be
emitted twice — once when the initial attempt is denied, and again with `waited: true` if the call is
ultimately rejected after waiting. No metrics are recorded.

## Examples

Reject and let retry handle the backoff:

```ts
import { createClient } from "@resili/core";

const client = createClient(callVendorApi, {
  rateLimiter: {
    strategy: "token-bucket",
    limit: 100,
    intervalMs: 1_000,
    burst: 120,
    onLimit: "reject",
  },
  retry: { maxAttempts: 3, jitter: "none", respectRetryAfter: true },
});
```

Absorb bursts by waiting, with a strict rolling window:

```ts
const client = createClient(callVendorApi, {
  rateLimiter: {
    strategy: "sliding-window",
    limit: 10,
    intervalMs: 1_000,
    onLimit: "wait",
    maxWaitMs: 2_000,
  },
  timeout: { perAttemptMs: 5_000 }, // must exceed maxWaitMs
});
```

## Limitations

- State is in-memory and per client instance. Ten replicas with `limit: 100` allow 1000 requests per
  second in aggregate; divide your quota by replica count, or supply a custom `StateStore`.
- `burst` applies only to `token-bucket`.
- Waiters are FIFO with no priority or fairness weighting.
- There is no reservation or scheduling API; you cannot ask "when could this run?" without attempting
  it.
