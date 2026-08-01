# Hedged Requests Design

> Status: design proposal for Resili v0.2.0
> Theme: Intelligent Request Management
> Scope: `@resili/core` only

## Problem Statement

Some downstream calls have long-tail latency: most requests finish quickly, but a small percentage stall on a slow instance, queue, connection, or network path. Hedged requests reduce tail latency by starting a duplicate execution after a short delay and returning the first acceptable result.

Resili should support hedging as a first-class policy that fits the existing middleware architecture:

```ts
const client = resili(fetchUser)
  .hedge({
    delay: 100,
  })
  .build();
```

Hedging can duplicate side effects. The public docs must state that it should generally be used only for safe or idempotent operations, or for operations guarded by external idempotency keys.

## Goals

- Start the original execution immediately.
- Start one hedge execution after a configured delay when no acceptable result has completed.
- Return the first successful result.
- Keep a running attempt alive when another attempt has failed but success is still possible.
- Abort or otherwise clean up losing attempts after a winner is selected.
- Respect parent `AbortSignal` and context deadlines.
- Use the injected `Clock` for hedge-delay timers.
- Avoid timer, listener, promise, and context-resource leaks.
- Emit typed lifecycle events consistent with existing event conventions.
- Record low-cardinality metrics if metrics are wired for policies.
- Preserve the existing public API and policy model.

## Non-Goals

- Request deduplication.
- Memory cache.
- Redis, distributed coordination, or cross-process hedge coordination.
- More than one hedge attempt in the initial implementation.
- Adaptive delay selection or percentile-based tuning.
- Policy changes that alter retry, timeout, circuit breaker, bulkhead, rate limiter, or fallback behavior.
- A breaking change to `Context`, `Policy`, `PolicyFactory`, `Builder`, or `ResiliConfig`.
- Forcibly stopping operations that ignore `AbortSignal`.

## Repository Architecture Findings

The repository is a pnpm workspace with packages under `packages/*`:

- `packages/core` contains the public Resili API, core abstractions, concrete policies, and tests.
- `packages/fetch`, `packages/axios`, and `packages/undici` are thin adapters over `@resili/core`.
- Root scripts run workspace build, lint, format, typecheck, tests, API extraction, and packaging.
- Public API is intentionally exported through `packages/core/src/index.ts`; deep imports are not part of the public contract.
- Built-in policies are internal policy factories exported as public factory values and configured through builder/config shortcuts.
- Existing concrete policies live in `packages/core/src/policies/<policy>/index.ts` with colocated Vitest tests.

The current flow is:

1. `resili(operation)` calls `createBuilder(operation)`.
2. Fluent builder methods such as `.retry(...)` and `.timeout(...)` append immutable `PolicyRegistration` snapshots.
3. `build()` creates an event bus, installs plugins, creates `PolicyServices`, creates policies through `PolicyFactory.create(services, options)`, and compiles them with `compilePipeline`.
4. `compilePipeline` sorts policies by numeric or relative `PolicyOrder`.
5. Pipeline execution creates one root `Context`, builds an onion chain, calls the outer policy first, and releases root context resources in `finally`.
6. Each policy receives `execute(ctx, next)` and may call `next(ctx)`, fork context, short-circuit, observe, retry, time-box, or transform errors.
7. The innermost operation receives the current `Context`; adapters pass `ctx.signal` into transport options.

Canonical current order is:

```text
fallback -> retry -> circuit-breaker -> timeout -> rate-limiter -> bulkhead -> operation
```

## Proposed Public API

Add a fluent builder method and declarative config key:

```ts
const client = resili(fetchUser)
  .hedge({
    delay: 100,
  })
  .build();
```

```ts
const client = createClient(fetchUser, {
  hedge: {
    delay: 100,
  },
});
```

Recommended public interface:

```ts
export interface HedgeOptions<T = unknown> {
  /**
   * Delay before starting the hedge attempt, in milliseconds.
   */
  readonly delay: number;

  /**
   * Maximum total executions for one logical call.
   *
   * v0.2 should accept only 2. The field exists to keep the option shape
   * extensible without later renaming.
   */
  readonly maxAttempts?: 2;

  /**
   * Returns true when a successful value is acceptable and should win.
   *
   * Defaults to the shared classifier: a success outcome is acceptable when
   * `services.classifier.isFailure(outcome, ctx)` is false.
   */
  readonly shouldAccept?: (value: T, ctx: Context) => boolean;

  /**
   * Whether to abort losing attempts after a winner is selected.
   *
   * Defaults to true.
   */
  readonly abortLosers?: boolean;
}
```

Naming rationale:

- `hedge` matches the resilience-pattern noun and the desired fluent API.
- `delay` is short and consistent with user intent, while validation fields should use `hedge.delay`.
- `maxAttempts` follows retry terminology and includes the original attempt.
- `shouldAccept` is value-oriented and avoids overloading failure classification terminology.
- `abortLosers` documents best-effort cancellation explicitly.

## Option Definitions

| Option         |      Type |          Default | Validation                    | Notes                                                                                      |
| -------------- | --------: | ---------------: | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `delay`        |  `number` |         required | finite number >= 0            | Uses `services.clock.setTimeout`. `0` starts the hedge on the next scheduling turn.        |
| `maxAttempts`  |       `2` |              `2` | must be exactly `2` in v0.2   | Reserves future support for more hedges.                                                   |
| `shouldAccept` |  function | classifier-based | must be function when present | Called only for fulfilled values. Throwing from this predicate should reject that attempt. |
| `abortLosers`  | `boolean` |           `true` | must be boolean               | If false, losing attempt promises are observed and ignored, but not aborted by hedge.      |

Invalid options throw `ConfigurationError`, matching existing policy behavior.

## Execution Timeline

Default successful hedge timeline:

```text
t=0      original attempt starts with hedgeAttempt=1
t=100    hedge delay elapses; hedge attempt starts with hedgeAttempt=2
t=130    hedge fulfills with acceptable value
t=130    hedge result wins
t=130+   original attempt is aborted best-effort and observed until settlement
t=130+   policy resolves with hedge value
```

Fast original timeline:

```text
t=0      original attempt starts
t=60     original fulfills with acceptable value
t=60     hedge timer is cleared before it fires
t=60     policy resolves with original value
```

## Internal Architecture

Add a new concrete policy factory:

```text
packages/core/src/policies/hedge/index.ts
```

Internal components can remain in the same file for v0.2, following current policy style:

- `hedgePolicy`: `PolicyFactory` with name `hedge`.
- `HedgeOptions` and normalized options.
- `executeWithHedge(ctx, next, services, options)`.
- `HedgeCoordinator`: local per-call coordinator that tracks active attempts, failures, winner state, timer handle, and cleanup callbacks.
- `HedgeAttempt`: per-attempt record containing hedge attempt index, `AbortController`, child context, promise state, and start time.

Attempt context behavior:

- The first attempt should use `ctx.fork({ attemptNumber: ctx.attemptNumber, signal: attemptController.signal, metadata })`, not the raw parent context, so it can be aborted independently when the hedge wins.
- The hedge attempt should also preserve `attemptNumber: ctx.attemptNumber`.
- Hedge attempt identity should be stored in metadata, for example `resili.hedgeAttempt: 1 | 2`, because `attemptNumber` is already owned by retry.
- The child signal composes parent cancellation, deadline cancellation, and attempt-local cancellation through `Context.fork`.
- Each child context must be released when its attempt settles if `Context.fork` continues to allocate signal resources tracked by `releaseContext`.

Scheduling behavior:

- Schedule the hedge timer with `services.clock.setTimeout`.
- Clear the hedge timer if a winner is selected before it fires.
- If `ctx.signal.aborted` before scheduling, throw `AbortError` or preserve the abort reason when it is already an error.
- Register a parent abort listener once, with `{ once: true }`, to abort attempt controllers and reject the coordinator.
- Remove the parent abort listener in final cleanup.
- Every started attempt must attach fulfillment and rejection handlers so loser rejection cannot become unhandled.

The implementation should avoid `Promise.race` over raw attempt promises because losing promises still need explicit observation and cleanup. A coordinator-owned result promise is easier to reason about.

## Policy Ordering

Recommended canonical order with hedge:

```text
fallback -> retry -> circuit-breaker -> timeout -> hedge -> rate-limiter -> bulkhead -> operation
```

Recommended numeric order:

```text
fallback: 100
retry: 200
circuit-breaker: 300
timeout: 400
hedge: 450
rate-limiter: 500
bulkhead: 600
```

Ordering rationale:

- Fallback remains outermost so it can handle terminal hedge, timeout, retry, breaker, rate limit, and bulkhead failures.
- Retry should wrap hedge so each retry attempt may hedge internally, and retry sees one logical attempt result.
- Circuit breaker should wrap timeout and hedge so it observes the final per-attempt outcome, including timeout failures, without counting each parallel hedge sub-attempt separately.
- Timeout should wrap hedge so the per-attempt timeout budget includes hedge delay, admission waits, and transport execution.
- Hedge should sit outside rate limiter and bulkhead so every duplicate execution must pass admission control independently.
- Rate limiter should remain outside bulkhead so duplicate hedge executions consume rate permits before concurrency slots.
- Bulkhead remains closest to the transport to bound actual in-flight operations.

This order means a single retry attempt can briefly consume two rate permits and two bulkhead slots. That is intentional and must be documented.

## Result-Selection Rules

### First Attempt Succeeds

- If the original attempt fulfills with an acceptable value before hedge starts, return it.
- Clear the hedge timer.
- Emit completion event with `hedged: false` and `winningAttempt: 1`.
- Do not start the hedge.

### Hedge Succeeds First

- If the hedge fulfills with an acceptable value first, return it.
- Abort the original attempt when `abortLosers` is true.
- Observe the original promise until it settles to prevent unhandled rejections.
- Emit completion event with `hedged: true` and `winningAttempt: 2`.

### One Attempt Fails While Another Is Running

- Store the failure.
- Do not reject while at least one attempt is still running or the hedge can still be started.
- If the other attempt later succeeds with an acceptable value, return the success.
- If the other attempt fails, reject according to the all-failed rule.

### All Attempts Fail

- Reject with the last failure by default, preserving the original thrown value.
- If both attempts fail and one error is a Resili error, event payloads may include the last Resili error code.
- Do not introduce a new aggregate error in v0.2 unless implementation reveals a strong need; preserving existing thrown values is less disruptive.

### Parent Execution Is Aborted

- Clear the hedge timer.
- Abort all active attempt controllers.
- Reject with `AbortError` when the abort reason is not already an `Error`; otherwise reject with the abort reason if preserving it is more consistent with context behavior.
- Emit an abort/cancel lifecycle event if the event model accepts it; otherwise rely on the terminal error observed by outer policies and request completion when request events are implemented.

### Hedge Delay Is Longer Than Total Deadline

- If `services.clock.now() + delay >= ctx.deadline`, do not schedule or start the hedge.
- Execute only the original attempt and let the existing deadline or timeout behavior settle the call.
- Emit a skipped event only if events include `HedgeSkipped`; otherwise do not emit a hedge event.

## Error Behavior

- Option validation throws `ConfigurationError`.
- Downstream success that `shouldAccept` rejects should be treated as an attempt failure for hedge selection, with the predicate error as that attempt's failure.
- Unacceptable successful values should not win; they should be classified as a failed attempt for selection and may be returned only if no acceptable result exists and the final design explicitly chooses that behavior.
- Recommended v0.2 rule: if all attempts either throw or produce unacceptable values, reject with the last thrown error, or a `ConfigurationError`/plain `Error` explaining that no acceptable hedge result completed when there were only unacceptable successes.
- Parent cancellation should not be treated as retryable or as a breaker failure.
- Timeout remains represented by existing `TimeoutError` from the timeout policy.

## Cancellation Behavior

- Hedge cancellation is best effort because JavaScript cannot forcefully stop arbitrary promises.
- Attempt-local `AbortController`s allow transports that use `ctx.signal` to cancel network work.
- Losing attempts must always be observed after the winner resolves.
- The hedge timer must be cleared in every terminal path.
- Parent abort listeners must be removed in every terminal path.
- Child contexts created with `ctx.fork` should be released in each attempt's `finally` to avoid deadline timer/listener leaks.
- If `abortLosers` is false, losing attempts are not aborted but their settlement is still observed.
- If the hedge timer fires after the coordinator has settled, it must be a no-op.

## Events

Existing event names use PascalCase and usually past/perfect tense for lifecycle events. Additive event types should be:

```ts
type HedgeEventType =
  | "HedgeScheduled"
  | "HedgeStarted"
  | "HedgeCompleted"
  | "HedgeFailed"
  | "HedgeAborted"
  | "HedgeSkipped";
```

Recommended payloads:

| Event            | Emitted when                                 | Payload                                                                         |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `HedgeScheduled` | Original starts and hedge timer is scheduled | `attemptNumber`, `hedgeAttempt`, `delayMs`, `scheduledAt`                       |
| `HedgeStarted`   | A hedge execution starts                     | `attemptNumber`, `hedgeAttempt`, `delayMs`                                      |
| `HedgeCompleted` | Hedge policy settles successfully            | `attemptNumber`, `winningHedgeAttempt`, `hedged`, `durationMs`, `losersAborted` |
| `HedgeFailed`    | All possible attempts fail                   | `attemptNumber`, `attempts`, `lastErrorCode?`, `durationMs`                     |
| `HedgeAborted`   | Parent abort cancels hedge coordination      | `attemptNumber`, `startedAttempts`, `hedgeStarted`, `reasonCode?`               |
| `HedgeSkipped`   | Hedge will not be scheduled                  | `attemptNumber`, `reason`, where reason is `deadline` or `delay-disabled`       |

To keep v0.2 minimal, implementation may start with `HedgeStarted`, `HedgeCompleted`, and `HedgeFailed`. `HedgeScheduled`, `HedgeSkipped`, and `HedgeAborted` are useful but create more event surface.

All event payloads extend `ResiliEventBase` with timestamp, requestId, operationName, and serviceName.

## Metrics

Existing metric conventions:

- Names use `resili_` prefix and `snake_case`.
- Duration metrics use `_ms`.
- Labels must be low-cardinality and must not include `requestId`.
- Standard labels are `service`, `operation`, and sometimes `key`.
- The current built-in policies mostly emit events but do not yet record metrics in code.

Recommended hedge metrics when policy metrics are implemented:

| Metric                        | Type      | Labels                           | Meaning                                                                                                     |
| ----------------------------- | --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `resili_hedge_attempts_total` | counter   | `service`, `operation`, `result` | Count original and hedge attempt settlements. `result` is `success`, `error`, `aborted`, or `unacceptable`. |
| `resili_hedges_started_total` | counter   | `service`, `operation`           | Count duplicate hedge executions actually started.                                                          |
| `resili_hedges_won_total`     | counter   | `service`, `operation`, `winner` | Count winners. `winner` is `original` or `hedge`.                                                           |
| `resili_hedge_delay_ms`       | histogram | `service`, `operation`           | Configured delay observed per scheduled hedge.                                                              |
| `resili_hedge_duration_ms`    | histogram | `service`, `operation`, `status` | End-to-end duration inside hedge policy.                                                                    |
| `resili_hedge_inflight`       | gauge     | `service`, `operation`           | Optional active sub-attempt count.                                                                          |

If v0.2 does not add metrics to other policies first, hedge should either defer metric recording or record only through the existing `MetricsRecorder` without adding a metrics facade.

## Edge Cases

- `delay: 0` can start the hedge immediately after the original has been scheduled; tests should assert deterministic order.
- Original fails before hedge delay, hedge has not started: the policy should keep the timer and allow the hedge to start unless parent cancellation/deadline prevents it.
- Original produces an unacceptable success before hedge delay: the hedge should still start.
- Hedge delay exceeds remaining deadline: skip hedge and execute only original.
- Parent signal already aborted: no attempt should start.
- Parent signal aborts while timer is pending: clear timer and abort original.
- Parent signal aborts while both attempts are running: abort both and reject once.
- Losing attempt ignores abort and resolves later: no unhandled rejection, no second resolution.
- Losing attempt rejects after winner: rejection is observed and ignored.
- Both attempts fail in same clock tick: deterministic last-error selection based on settlement order.
- Timeout fires while hedge timer pending: timeout policy aborts the hedge policy through context signal.
- Bulkhead saturation caused by hedge: duplicate attempt may throw `BulkheadRejectedError` while original continues.
- Rate limiter exhaustion caused by hedge: duplicate attempt may throw `RateLimitExceededError` while original continues.
- Retry combined with hedge can multiply executions: `retry.maxAttempts * hedge.maxAttempts`.
- Circuit breaker half-open probes should not be multiplied unexpectedly if hedge is inside the breaker; only one breaker permit wraps the logical attempt.

## Policy Ordering Details

### Retry

`retry -> hedge` means each retry attempt may hedge. This minimizes latency per attempt but can multiply load. Users should reduce retry attempts, increase hedge delay, or disable hedging for non-idempotent operations.

### Timeout

`timeout -> hedge` means one timeout budget covers both original and hedge sub-attempts. A hedge should never outlive the timeout policy's child signal.

### Circuit Breaker

`circuit-breaker -> timeout -> hedge` means the breaker sees one logical attempt outcome. It does not count duplicate hedge sub-attempts separately. This avoids a hedge increasing breaker sample volume by itself.

### Bulkhead

`hedge -> rate-limiter -> bulkhead` means each sub-attempt competes for a bulkhead permit. This bounds actual in-flight transport calls but can use two permits for one logical request.

### Rate Limiter

`hedge -> rate-limiter` means each sub-attempt consumes a rate-limit permit. This prevents hedge from bypassing admission control and makes added load visible.

### Fallback

Fallback remains outside all policies and handles terminal hedge failure the same way it handles terminal retry, timeout, rate-limit, bulkhead, and breaker failures.

## Risks

- Duplicate writes for non-idempotent operations.
- Increased downstream load during latency spikes.
- Retry and hedge multiplication can create request amplification.
- `AbortSignal` cancellation is cooperative; some operations will continue after losing.
- Circuit breaker may undercount sub-attempt failures if hedge is inside the breaker, but counting each sub-attempt would distort breaker volume.
- Rate limiter and bulkhead capacity may need retuning because one logical request can consume two permits.
- Deterministic deadline tests are limited by the current `Context` implementation using `systemClock` for deadline timers.
- If `shouldAccept` is too strict, the policy may run duplicate work and still fail despite successful transport results.

## Documentation Requirements

- Add user-facing docs after implementation, likely `docs/11-hedged-requests.md`.
- Update `docs/ARCHITECTURE.md` canonical order and sequence diagrams after design approval.
- Update `docs/API_SPECIFICATION.md` with `HedgeOptions`, `.hedge(...)`, config key, events, and metrics after API approval.
- Update `docs/INTERNAL_DESIGN.md` with the hedge internal flow.
- Update `README.md` examples only after the policy is implemented.
- Document safe/idempotent operation guidance prominently.
- Document load amplification with retry and hedging.
- Document cancellation limitations.

## Benchmark Plan

- Add a benchmark scenario with synthetic latency distribution: fast p50, slow p95/p99.
- Compare no hedge versus hedge delay values such as 25ms, 50ms, 100ms, and 200ms.
- Measure p50, p95, p99, mean duration, attempts per logical call, and loser abort count.
- Include scenarios where downstream capacity is constrained by bulkhead and rate limiter.
- Include a retry-plus-hedge amplification scenario.
- Benchmark with `noopMetrics` and with a simple in-memory metrics recorder to estimate observability overhead.

## Test Plan

| Area                 | Scenario                                      | Expected result                                                    |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Factory              | default immutable policy from valid options   | `name` is `hedge`, `order` is `450`, policy is frozen              |
| Validation           | missing options                               | `ConfigurationError` on `hedge`                                    |
| Validation           | `delay < 0`, `NaN`, `Infinity`, wrong type    | `ConfigurationError` on `hedge.delay`                              |
| Validation           | `maxAttempts` not `2`                         | `ConfigurationError` on `hedge.maxAttempts`                        |
| Validation           | `shouldAccept` not function                   | `ConfigurationError` on `hedge.shouldAccept`                       |
| Validation           | `abortLosers` not boolean                     | `ConfigurationError` on `hedge.abortLosers`                        |
| Builder              | `.hedge(...)` returns immutable snapshot      | original builder unchanged                                         |
| Config               | `createClient(..., { hedge })` applies policy | client call uses hedge policy                                      |
| Pipeline             | built-in order includes hedge at 450          | order is timeout, hedge, rate-limiter                              |
| First success        | original succeeds before delay                | hedge not started, timer cleared                                   |
| Hedge win            | hedge succeeds before original                | hedge result returned, original signal aborted                     |
| Failure then success | original fails, hedge succeeds                | success returned                                                   |
| Failure then success | hedge fails, original succeeds                | success returned                                                   |
| All fail             | original and hedge fail                       | rejects with last failure                                          |
| Parent abort         | signal aborted before call                    | no attempt starts, rejects aborted                                 |
| Parent abort         | signal aborted before hedge timer fires       | timer cleared, original aborted                                    |
| Parent abort         | signal aborted with both running              | both attempt signals aborted                                       |
| Timeout              | timeout fires before hedge delay              | hedge timer cleared by context abort path                          |
| Deadline             | `now + delay >= ctx.deadline`                 | hedge skipped                                                      |
| Cleanup              | winner before timer                           | no active timers                                                   |
| Cleanup              | winner after both running                     | no unhandled loser rejection                                       |
| Cleanup              | loser ignores abort and resolves later        | result remains winner, no extra event                              |
| Metadata             | sub-attempts include hedge metadata           | `resili.hedgeAttempt` is `1` and `2`                               |
| Attempt number       | hedge does not increment retry attempt        | both sub-attempt contexts preserve retry attempt number            |
| Events               | hedge starts                                  | `HedgeStarted` payload includes delay and hedge attempt            |
| Events               | original wins                                 | `HedgeCompleted` has `hedged: false`, winner `1`                   |
| Events               | hedge wins                                    | `HedgeCompleted` has `hedged: true`, winner `2`                    |
| Events               | all fail                                      | `HedgeFailed` includes attempts and last error code when available |
| Metrics              | hedge starts                                  | started counter increments with low-cardinality labels             |
| Metrics              | hedge wins                                    | winner counter labels `winner: "hedge"`                            |
| Rate limiter         | hedge consumes second token                   | second sub-attempt can be rate limited while original continues    |
| Bulkhead             | hedge competes for permit                     | second sub-attempt can be rejected while original continues        |
| Retry                | retry wraps hedge                             | max executions equals retry attempts times hedge attempts          |
| Fallback             | all hedge attempts fail                       | fallback can handle terminal failure                               |

## Files To Change For Implementation

Expected implementation files:

- `packages/core/src/policies/hedge/index.ts`
- `packages/core/src/policies/hedge/index.test.ts`
- `packages/core/src/core/builder/index.ts`
- `packages/core/src/core/builder/index.test.ts`
- `packages/core/src/core/pipeline/index.ts`
- `packages/core/src/core/pipeline/index.test.ts`
- `packages/core/src/core/policy/index.ts`
- `packages/core/src/core/policy/index.test.ts`
- `packages/core/src/core/events/index.ts`
- `packages/core/src/core/events/index.test.ts`
- `packages/core/src/index.ts`
- `packages/core/src/index.test.ts`

Likely documentation files after implementation:

- `docs/ARCHITECTURE.md`
- `docs/API_SPECIFICATION.md`
- `docs/INTERNAL_DESIGN.md`
- `README.md`
- `packages/core/README.md`

Possible supporting change:

- `packages/core/src/core/context.ts`

Only change `context.ts` if implementation needs an internal way to release forked contexts or to use the injected `Clock` for deadline timers. Do not change it casually because it is shared by every policy.

## Unresolved Questions

- Should v0.2 expose all hedge events or start with only `HedgeStarted`, `HedgeCompleted`, and `HedgeFailed`?
- Should an unacceptable fulfilled value be represented by a new typed error or by a plain internal error?
- Should parent abort preserve `ctx.signal.reason` exactly or normalize to public `AbortError`?
- Should `HedgeOptions<T>` be generic publicly, or should `shouldAccept` accept `unknown` to avoid exposing another generic on `Builder`?
- Should hedge metrics be implemented now even though current built-in policies mostly do not record metrics yet?
- Should `Context` gain an internal/public release API for forked child contexts?
- Should the built-in policy order anchors and public `PolicyOrder` built-in union include `hedge` in v0.2?
- Should `maxAttempts` be omitted until more than one hedge is supported, or included now with exact value `2`?

## Implementation Checklist

- Add `hedge` to built-in order at `450`.
- Add `"hedge"` to `PolicyOrder` relative anchors.
- Add `HedgeOptions` and `hedgePolicy`.
- Add `.hedge(options)` to `Builder`.
- Add `hedge?: HedgeOptions<R>` to `ResiliConfig`.
- Add `hedge` validation to supported config keys.
- Export `HedgeOptions` and `hedgePolicy` from the package entry.
- Add hedge event types and event map entries.
- Implement coordinator with injected-clock timer scheduling.
- Implement parent abort listener cleanup.
- Implement attempt-local abort controllers.
- Implement child context release for forked attempt contexts.
- Implement result-selection rules.
- Implement event emissions.
- Add metrics only if aligned with current metrics implementation scope.
- Add unit tests for policy behavior, builder/config wiring, pipeline order, events, cleanup, abort, timeout/deadline interaction, and public exports.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
