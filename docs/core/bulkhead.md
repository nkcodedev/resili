# Bulkhead

Caps how many executions may run at once, with an optional bounded wait queue.

**Pipeline position:** order `600` — the innermost policy, immediately around the operation.

## When to use it

To stop one dependency from consuming resources everything else needs. If a downstream slows from
20 ms to 5 s, an unbounded caller will pile up thousands of in-flight requests, exhaust connections
and memory, and take down endpoints that have nothing to do with the slow dependency. A bulkhead
turns that into a fast, local rejection.

Use a bulkhead to bound _concurrency_; use a [rate limiter](rate-limiter.md) to bound _arrival rate_.

## Configuration

```ts
interface BulkheadOptions {
  readonly maxConcurrent: number;
  readonly maxQueue?: number;
  readonly queueTimeoutMs?: number;
  readonly key?: string | ((ctx: Context) => string);
}
```

| Option           | Default           | Notes                                                        |
| ---------------- | ----------------- | ------------------------------------------------------------ |
| `maxConcurrent`  | required          | Integer `>= 1`. Concurrent executions permitted per key.     |
| `maxQueue`       | `0`               | Queue capacity. `0` means reject immediately when saturated. |
| `queueTimeoutMs` | `0`               | Max time in the queue. Requires `maxQueue > 0`.              |
| `key`            | `ctx.serviceName` | Partition key. Slots are isolated per resolved key.          |

A number shorthand sets `maxConcurrent` only:

```ts
createClient(operation, { bulkhead: 20 });
createClient(operation, { bulkhead: { maxConcurrent: 20, maxQueue: 50 } });
```

## Behavior

1. Resolve the partition key.
2. If active executions are below `maxConcurrent`, take a slot and proceed.
3. Otherwise, if the queue is at `maxQueue` (including the default `0`), throw
   `BulkheadRejectedError`.
4. Otherwise enqueue and wait. If `queueTimeoutMs` elapses first, the waiter is removed from the
   queue and rejected with `BulkheadRejectedError`.
5. The slot is released in a `finally`, on success and on failure alike, and the next queued waiter is
   admitted in FIFO order.

## Errors

`BulkheadRejectedError` (`ERR_BULKHEAD_FULL`) carries `maxConcurrent`, `queueSize`, and `waitedMs`
(`0` for an immediate rejection).

The default classifier treats it as **retryable but not a failure**: retrying makes sense because the
saturation is local and transient, and it should not count toward opening a circuit breaker on the
downstream, which never saw the call.

## AbortSignal

The bulkhead does not observe `ctx.signal`. A queued caller is not removed from the queue when the
caller cancels — it waits for a slot or for `queueTimeoutMs`, then observes the cancellation
downstream. Set `queueTimeoutMs` to bound that wait rather than relying on cancellation.

## Interaction with other policies

- **Retry** is outside, so each attempt re-acquires a slot. A `BulkheadRejectedError` is retryable,
  which effectively turns retry backoff into an admission wait.
- **Timeout** is outside, so queue wait time counts against `perAttemptMs`. Keep
  `queueTimeoutMs < perAttemptMs`, otherwise the attempt times out while queued and the queue slot is
  wasted.
- **Dedupe** is outside: joiners share the owner's slot instead of taking their own.
- **Hedge** is outside, so a hedged attempt competes for the same slots as the original.

## Events

`BulkheadRejected` with `key`, `maxConcurrent`, `queueSize`, and `waitedMs`. No metrics are recorded.

## Example

```ts
import { BulkheadRejectedError, createClient } from "@resili/core";

const client = createClient(queryReportingDb, {
  bulkhead: {
    maxConcurrent: 10,
    maxQueue: 20,
    queueTimeoutMs: 500,
    key: "reporting-db",
  },
  timeout: { perAttemptMs: 3_000 },
  fallback: (error) => {
    if (error instanceof BulkheadRejectedError) {
      return { degraded: true, rows: [] };
    }
    throw error;
  },
});
```

Partitioning by tenant so one noisy tenant cannot exhaust the pool:

```ts
const client = createClient(operation, {
  bulkhead: {
    maxConcurrent: 5,
    key: (ctx) => String(ctx.metadata.get("tenantId") ?? "anonymous"),
  },
});
```

## Limitations

- State is in-memory and per client instance. Concurrency limits are per process, not cluster-wide.
- Queued callers ignore cancellation; use `queueTimeoutMs`.
- FIFO only — no priority lanes or fairness weighting.
- There is no way to inspect current utilization; the bulkhead records no metrics or gauges.
