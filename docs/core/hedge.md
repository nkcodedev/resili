# Hedge

Starts a second, duplicate attempt after a delay and takes whichever finishes acceptably first.

**Pipeline position:** order `450` — inside dedupe and timeout, outside admission control.

> Not listed in the original documentation plan, but `hedgePolicy` is exported public API and is
> configurable through the `hedge` config key, so it is documented here.

## When to use it

To cut tail latency. When p50 is 20 ms but p99 is 2 s because of an unlucky server, a GC pause, or a
cold cache, a hedge started at 50 ms usually wins and the slow original is discarded.

Only hedge **safe, idempotent** work. A hedge is an extra real call to your dependency; on a
non-idempotent operation it can double-charge, double-send, or double-write. It also increases load
by design, so hedge selectively rather than globally.

## Configuration

```ts
interface HedgeOptions<T> {
  readonly delay: number;
  readonly maxAttempts?: 2;
  readonly shouldAccept?: (value: T, ctx: Context) => boolean;
  readonly abortLosers?: boolean;
}
```

| Option         | Default  | Notes                                                           |
| -------------- | -------- | --------------------------------------------------------------- |
| `delay`        | required | Milliseconds before the hedge starts. Finite, `>= 0`.           |
| `maxAttempts`  | `2`      | Must be exactly `2`. Any other value is a `ConfigurationError`. |
| `shouldAccept` | —        | Judges whether a successful value counts as a win.              |
| `abortLosers`  | `true`   | Abort the losing attempt once a winner is chosen.               |

`maxAttempts` is typed as the literal `2` and validated at build time: this alpha supports the
original plus exactly one hedge. Pick `delay` from your latency distribution — somewhere around p90
is a reasonable starting point, since a delay below p50 hedges almost every request.

## Behavior

1. If the parent is already aborted, reject immediately, emit `HedgeAborted`, and start nothing.
2. Start attempt 1 on a forked child context with its own `AbortController`.
3. Schedule attempt 2 for `delay` milliseconds later via the injected `Clock`.
4. If `now + delay` would exceed the context deadline, skip the hedge and emit `HedgeSkipped` —
   there is no point starting work that cannot finish.
5. On the timer, start attempt 2 unless the call has already settled or been aborted.
6. The first **acceptable** success wins. With no `shouldAccept`, every success is acceptable; a
   `shouldAccept` returning `false` treats that value as a failure and keeps waiting.
7. The winner settles the call, and losers are aborted when `abortLosers` is `true`.
8. If all started attempts settle without an acceptable result, the last failure is thrown — or a
   plain `Error("No acceptable hedged result completed.")` if there is no failure to report.

If the original fails _before_ the delay elapses, the policy still waits for the scheduled hedge
rather than failing early.

## Errors

`ConfigurationError` for invalid options. Otherwise the last attempt failure, or the plain
`Error` noted above — which is deliberately **not** a `ResiliError`, so `isResiliError()` returns
`false` for it. Parent cancellation rejects with the signal's reason if it is an `Error`, else
`AbortError`.

## AbortSignal

Each attempt runs on its own forked context and controller, so attempts are independently
cancellable.

- Parent abort cancels all running attempts and rejects with the parent's abort error.
- Parent abort before the delay elapses means the hedge never starts.
- When `abortLosers: true`, the loser is aborted using the winner's resolution as the trigger.

## Interaction with other policies

- **Retry** is outside hedge, so the two multiply: up to `retry maxAttempts × 2` downstream calls.
  Combine them deliberately.
- **Timeout** is outside, so `perAttemptMs` bounds the original _and_ the hedge together; a timeout
  aborts both attempts' signals.
- **Rate limiter** and **bulkhead** are inside, so a hedge consumes its own permit and its own slot.
  Hedging under a tight bulkhead can make the hedge queue behind the original.
- **Dedupe** is outside, so one deduplicated logical call has one hedge coordinator, not one per
  caller.

## Events and metrics

Events: `HedgeScheduled`, `HedgeStarted`, `HedgeCompleted`, `HedgeFailed`, `HedgeAborted`,
`HedgeSkipped`.

Metrics: `resili_hedges_started_total`, `resili_hedges_won_total` (labelled `winner: "original" |
"hedge"`), `resili_hedge_attempts_total`, `resili_hedge_duration_ms`, and `resili_hedge_delay_ms`.
The `winner` label is the one to watch — if the hedge wins most of the time, your delay is too low
and you are doubling load for little benefit. See [Metrics](../observability/metrics.md).

## Example

```ts
import { createClient } from "@resili/core";

const search = createClient(async (query: string) => searchIndex(query), {
  hedge: {
    delay: 80, // near p90
    shouldAccept: (result) => result.hits.length > 0,
  },
  timeout: { perAttemptMs: 1_000 },
  bulkhead: { maxConcurrent: 50 },
});
```

## Limitations

- Exactly one hedge is supported; `maxAttempts` must be `2`.
- Increases downstream load by design. Not appropriate for expensive or non-idempotent work.
- The "no acceptable result" error is a plain `Error`, not a `ResiliError` with a code.
- The hedge is skipped, not shortened, when the delay would exceed the deadline.
- There is no adaptive delay; `delay` is static and not derived from observed latency.
