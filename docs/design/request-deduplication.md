# Request Deduplication Design

## Status and Scope

Status: design-only proposal for Resili v0.2 feature #2.

This document designs request deduplication as a first-class Resili policy. It does not implement runtime behavior, builder wiring, exports, events, metrics, cache, distributed coordination, or package metadata changes.

The policy shares only concurrent in-flight work. It never stores completed results and must not become a cache.

## Problem Statement

Many callers may request the same resource at the same time:

```text
Caller A ─┐
Caller B ─┼── fetchUser("42")
Caller C ─┘
```

Without deduplication, each logical call executes the downstream operation independently. With deduplication, the first caller for a dedupe key creates one shared execution and concurrent same-key callers join that execution. Every caller receives the same successful value or terminal error unless that caller aborts its own wait.

## Goals

- Share concurrent in-flight work for the same dedupe key.
- Scope state to one built client instance.
- Remove in-flight entries immediately when shared execution settles.
- Preserve independent logical caller cancellation.
- Prevent one caller from cancelling shared work while other callers remain.
- Avoid promise, listener, timer, context, and registry-entry leaks.
- Preserve deterministic behavior under injected clocks and tests.
- Fit the existing `PolicyFactory` lifecycle, pipeline ordering model, validation conventions, event model, and metrics conventions.

## Non-Goals

- Completed-result storage.
- TTL, LRU, stale values, background refresh, or cache semantics.
- Redis, distributed locks, or cross-process coordination.
- User-supplied stores in v0.2.
- Object-identity keys.
- Async key functions.
- Batch coalescing or request collapsing after completion.
- Builder/API implementation in this design phase.
- Events or metrics implementation in this design phase.

## Repository Architecture Findings

- The monorepo uses `pnpm` workspaces with packages under `packages/*`; `@resili/core` contains the policy runtime and public entry point.
- `createBuilder` stores immutable policy registrations and creates one policy instance per built client in `build()`. Client-scoped state should therefore live inside the policy instance created by `PolicyFactory.create`.
- `createClient` is a declarative wrapper that applies config fields to the fluent builder before `build()`.
- `PolicyFactory.create(services, options)` validates options once at build time and returns an immutable `Policy` with `execute(ctx, next)`.
- `compilePipeline` sorts policies by numeric order and composes an onion chain from outer to inner. Current built-in order is `fallback:100`, `retry:200`, `circuit-breaker:300`, `timeout:400`, `hedge:450`, `rate-limiter:500`, `bulkhead:600`.
- `Context` is immutable. `Context.fork` composes parent signal, optional child signal, deadline signal, request identity, deadline, and metadata. Child contexts must be released with internal `releaseContext`.
- The clock abstraction supplies `now`, `setTimeout`, and `clearTimeout`; policies must not use raw timers directly.
- Retry forks contexts for later attempts and re-executes downstream policies per attempt.
- Timeout forks a child context with a timeout-local `AbortController`, races downstream execution against a timer, and clears the timer in `finally`.
- Hedge creates independent child attempt contexts, observes losing promises, aborts losers best-effort, uses the injected clock, emits typed events, and records low-cardinality metrics.
- Circuit breaker, rate limiter, and bulkhead maintain per-policy-instance in-memory maps, which supports a per-client dedupe registry.
- Events use PascalCase typed event names with standard base fields: `timestamp`, `requestId`, `operationName`, and `serviceName`.
- Metrics use a vendor-neutral `MetricsRecorder`; labels must be low-cardinality and never include `requestId`.
- Validation failures use `ConfigurationError` with field paths such as `hedge.delay`, `retry.maxAttempts`, and `rateLimiter.limit`.
- Existing tests use local fake clocks, gates, event arrays, recording metrics, operation call counts, and timer counts to prove lifecycle behavior.

## Proposed Public API

Recommended eventual fluent API:

```ts
const client = resili(fetchUser)
  .dedupe({
    key: (id) => id,
  })
  .build();
```

Recommended eventual declarative API:

```ts
const client = createClient(fetchUser, {
  dedupe: {
    key: (id) => id,
  },
});
```

Recommended types:

```ts
export type DedupeKey = string | number | symbol;

export interface DedupeOptions<Args extends readonly unknown[] = readonly unknown[]> {
  readonly key: (...args: Args) => DedupeKey;
  readonly abortSharedWhenUnused?: boolean;
}
```

The key function should receive the wrapped operation arguments, not `Context`, in v0.2. This matches the desired API, preserves operation argument types through `Builder<Args, R>`, and keeps keying deterministic and synchronous. Passing `Context` would make it easier to include service metadata, but would couple keys to execution metadata and make declarative examples less clear. If context-sensitive keying becomes necessary, add it later as an optional second parameter only after API review.

## Option Definitions

### `key`

- Required synchronous function.
- Receives the same argument list passed to `client.call(...args)`.
- Must return `string`, `number`, or `symbol`.
- Throws are propagated as `ConfigurationError` or the original thrown error depending on implementation convention. Recommendation: wrap thrown values in `ConfigurationError` with `field: "dedupe.key"` and `cause` to keep option failures typed.
- `null` and `undefined` are invalid in v0.2 rather than disabling dedupe. Disabling through a sentinel would be ambiguous and easy to misuse; callers can conditionally build clients or include a mode in the key.

### `abortSharedWhenUnused`

- Optional boolean.
- Default: `true`.
- When true, the shared execution's controller is aborted when the last active logical caller detaches before settlement.
- When false, the shared execution continues even when no callers remain, but its promise remains observed and the registry entry is removed after settlement.

## Key Model

Allowed key types: `string | number | symbol`.

Do not normalize keys to strings internally. Use `Map<DedupeKey, InFlightEntry<T>>` directly so `1` and `"1"` remain distinct and symbols retain identity semantics without stringification collisions.

Object keys should not be supported in v0.2. Object identity keys are difficult to reason about, invite accidental cardinality growth, and make stable cross-call dedupe unlikely unless callers reuse the same object instance.

Raw keys should not be emitted in events or used as metric labels. They may contain sensitive IDs, tenant names, URLs, or authorization scope.

## Policy Ordering

Recommended built-in order, outer to inner:

```text
fallback
-> retry
-> circuit-breaker
-> timeout
-> dedupe
-> hedge
-> rate-limiter
-> bulkhead
-> operation
```

Recommended numeric order: `425`, between `timeout:400` and `hedge:450`.

### Why This Order

Dedupe should share the expensive downstream protected attempt, including hedge, rate limiter, bulkhead, and the operation, while each logical caller still has its own outer fallback, retry, circuit-breaker, and timeout behavior.

Consequences:

- Same-key callers share one downstream attempt execution.
- Joined callers do not consume separate rate-limit tokens or bulkhead slots for the same shared execution.
- One shared execution produces one inner hedge execution group and one admission-control path.
- Each logical caller keeps independent fallback behavior.
- Each logical caller keeps independent retry behavior; if a joined caller times out or aborts locally, it can fail/retry according to its own outer policies without cancelling shared work for remaining callers.
- Each logical caller gets its own timeout budget around joining/waiting, because timeout is outside dedupe.
- A late joiner can inherit an almost-expired shared execution but retains its own outer timeout budget. If the shared execution completes soon, it benefits; if not, it can time out independently.

### Rejected Option B

Alternative:

```text
fallback
-> dedupe
-> retry
-> circuit-breaker
-> timeout
-> hedge
-> rate-limiter
-> bulkhead
-> operation
```

This would share the whole retry, circuit-breaker, timeout, hedge, admission, and operation pipeline. It reduces more duplicate work but creates undesirable coupling:

- One caller's retry loop would be shared by all callers.
- One caller's timeout budget could govern joiners with different deadlines.
- Fallback remains per-caller only if fallback stays outside, but retry and timeout no longer do.
- Late joiners can inherit a nearly exhausted retry or timeout state.
- Cancellation semantics become harder because an owner timeout could abort shared work for joiners.

Option A is safer for v0.2 because dedupe remains an in-flight sharing policy rather than a whole-logical-call sharing policy.

## Internal Architecture

Create a new policy package:

```text
packages/core/src/policies/dedupe/index.ts
packages/core/src/policies/dedupe/index.test.ts
```

The policy factory should create one private registry per built client:

```ts
type DedupeKey = string | number | symbol;

type SubscriberState = "active" | "settled";
type SharedState = "running" | "settled";

interface InFlightEntry<T> {
  readonly key: DedupeKey;
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  readonly context: Context;
  readonly createdAt: number;
  readonly ownerRequestId: string;
  readonly subscribers: Set<Subscriber<T>>;
  state: SharedState;
}

interface Subscriber<T> {
  readonly requestId: string;
  readonly context: Context;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly abortCleanup: () => void;
  state: SubscriberState;
}
```

A private `DedupeCoordinator` or `InFlightRegistry` should own these responsibilities:

- Resolve and validate the dedupe key synchronously.
- Look up the key in the client-scoped registry.
- Create an entry for a miss before starting downstream work.
- Register the owner as the first subscriber.
- Register joiners against existing entries.
- Start the shared execution with a coordinator-owned `AbortController` and child `Context`.
- Settle each subscriber independently.
- Detach subscribers on parent abort.
- Abort shared execution when unused if configured.
- Observe the shared promise even after all subscribers leave.
- Release the shared child context exactly once.
- Delete the registry entry exactly once after shared settlement.
- Delete with identity comparison: `if (registry.get(key) === entry) registry.delete(key)`.

## Registry Lifecycle

1. Normalize options at build time.
2. On each `execute(ctx, next)`, resolve the key synchronously from the operation arguments supplied by the client integration.
3. If no entry exists, create `InFlightEntry`, insert it into `Map` immediately, then start the shared execution in a microtask with `Promise.resolve().then(() => next(sharedContext))`.
4. If an entry exists and is still running, register the caller as a joiner.
5. When the shared promise fulfills or rejects, mark the entry settled, settle all active subscribers, release the shared context, and delete the map entry by identity comparison.
6. If a later caller arrives after deletion, it creates a new shared execution.
7. If a joiner arrives while settlement is in progress but before deletion, it may either join and be settled from the recorded outcome, or miss after deletion. The implementation must choose one deterministic path and test it. Recommendation: keep settlement synchronous in the shared promise handler so the entry is deleted before later microtasks can join.

## Subscriber Lifecycle

Each logical call has one subscriber record.

- Owner: subscriber that created the entry.
- Joiner: subscriber that found an existing running entry.
- Active subscriber count is `entry.subscribers.size` excluding settled/detached records.
- Subscriber attaches one `abort` listener to its logical context signal.
- Subscriber abort settles only that subscriber and removes its abort listener.
- Shared settlement removes every remaining subscriber listener before resolving/rejecting them.
- Detaching the final active subscriber triggers shared abort if `abortSharedWhenUnused` is true.

Subscriber promises are independent wrappers around the shared promise. Do not return the raw shared promise directly, because callers need independent abort behavior and listener cleanup.

## Cancellation Semantics

Recommended cancellation model:

- Each logical caller keeps its own parent signal and can stop waiting independently.
- A single joiner aborting rejects only that joiner and must not abort shared work for other callers.
- Owner abort is treated the same as joiner abort. Ownership only describes who created the shared execution; it does not grant cancellation authority while joiners remain.
- The shared execution uses a coordinator-owned `AbortController` passed through a shared child context.
- Shared execution is aborted only when no active subscribers remain and `abortSharedWhenUnused` is true.
- If every caller aborts, abort the shared controller best-effort, keep observing the shared promise, release the shared context on settlement, and remove the registry entry after settlement.
- If `abortSharedWhenUnused` is false, all callers may detach while shared work continues. This is allowed, but the promise must stay observed and cleanup must still occur.
- Operations that ignore `AbortSignal` may continue. JavaScript cannot forcefully stop arbitrary promises.

This model fits the current policy model because `Context.fork` can compose the shared controller with the owner context deadline, but it has one limitation: if the shared context is forked from the owner context, owner abort would abort the shared context. Therefore, dedupe must not compose the shared execution signal with any one caller's abort signal. It should create a shared child context that preserves request identity and deadline but uses only the coordinator-owned signal plus the logical deadline. If current `Context.fork` cannot express that, implementation must either add an internal context helper or stop for API/internal review instead of abusing owner context cancellation.

## Success and Failure Behavior

### Shared Success

- Shared execution fulfills with `value`.
- Entry state becomes settled.
- All active subscribers resolve with the same `value` reference.
- Subscriber listeners are removed before resolving.
- Shared context is released.
- Registry entry is removed by identity comparison.

Returned values are not cloned. If the value is mutable, one caller can mutate the object observed by another caller. This must be documented.

### Shared Failure

- Shared execution rejects or throws synchronously through `Promise.resolve().then(() => next(sharedContext))`.
- Entry state becomes settled.
- All active subscribers reject with the same error object.
- Subscriber listeners are removed before rejecting.
- Shared context is released.
- Registry entry is removed by identity comparison.

Failures are not cached. A later same-key caller starts a new execution.

### Key Function Throws

The operation is not started, no registry entry is inserted, and the logical caller rejects. Recommendation: throw `ConfigurationError` with `field: "dedupe.key"` and preserve the thrown value as `cause`.

### Invalid Key

If key returns `null`, `undefined`, object, boolean, bigint, or function, reject with `ConfigurationError` field `dedupe.key` and do not insert an entry.

## Context Behavior

Dedupe introduces a shared execution context distinct from all logical caller contexts.

Recommended behavior:

- Key function receives operation arguments, not context.
- Owner and joiner logical contexts remain independent and are not released by dedupe.
- Shared execution receives one context for the downstream pipeline.
- Shared context should preserve `operationName`, `serviceName`, deadline, metadata needed by inner policies, and `attemptNumber` from the current retry attempt.
- Shared context metadata should include dedupe role/metadata only if needed internally; avoid public metadata additions unless required.
- Shared context must be released exactly once in shared promise `finally`.
- Retry owns `attemptNumber`; dedupe must not increment it.

Open implementation constraint: current `Context.fork` always composes with the parent signal. That is correct for most policies but conflicts with dedupe's desired owner-abort independence. The implementation phase must verify whether an internal context creation helper can preserve identity/deadline without composing a specific caller signal. If not, stop and design that helper first.

## Integration With Existing Policies

### Retry

With recommended order `retry -> timeout -> dedupe`, each logical caller owns its retry loop. A retry attempt can join an in-flight execution created by another logical caller's same attempt. Shared failures are delivered to all active callers; each outer retry policy independently decides whether to retry.

Risk: retry amplification can occur when many callers receive the same failure and retry together. Document backoff and jitter guidance once jitter modes are implemented.

### Timeout

Timeout is outside dedupe, so each caller has an independent timeout for waiting on the shared execution. A caller timeout detaches that subscriber only. Shared execution is aborted only if no subscribers remain and `abortSharedWhenUnused` is true.

Potential limitation: the shared downstream context's deadline must be chosen carefully. Recommendation: use the earliest deadline among active subscribers for the shared execution only if the context system can update it safely; otherwise use the owner attempt deadline and document that later joiners may have shorter local budgets but cannot shorten shared execution.

### Hedge

Dedupe should be outside hedge. Same-key callers share one hedging coordinator rather than each spawning duplicate hedges. This prevents hedge multiplication under thundering-herd workloads.

If dedupe were inside hedge, each hedge sub-attempt might dedupe separately and obscure hedging behavior. That is not recommended for v0.2.

### Circuit Breaker

Circuit breaker is outside dedupe in the recommended order. Each logical caller enters the breaker before dedupe, so each caller may produce a breaker observation around its logical wait. This is conservative for caller-visible reliability but may count one shared downstream failure multiple times.

Alternative would put dedupe outside circuit breaker to produce one breaker observation per shared execution. That would better match downstream load but share retry/timeout concerns poorly. For v0.2, prefer preserving caller-visible outer policy semantics and document breaker-counting trade-offs.

### Rate Limiter

Rate limiter is inside dedupe. Same-key joiners do not consume additional rate-limit tokens while joining an existing execution. Different keys execute independently and consume their own tokens.

### Bulkhead

Bulkhead is inside dedupe. Same-key joiners do not consume additional bulkhead slots. The shared execution consumes one slot when it reaches bulkhead.

### Fallback

Fallback is outside dedupe and remains per logical caller. If a subscriber aborts or times out, that caller can receive its own fallback result while the shared execution continues for other subscribers.

## Events Design

Do not implement events in the initial runtime phase unless explicitly requested later.

Minimal future typed event surface:

- `DedupeMiss`: no in-flight entry existed and this caller created one.
- `DedupeJoined`: caller joined an existing entry.
- `DedupeCompleted`: shared execution completed successfully.
- `DedupeFailed`: shared execution failed.
- `DedupeCallerAborted`: one logical caller detached due to its signal.
- `DedupeSharedAborted`: shared controller was aborted because no active callers remained.

Payload direction:

- Include standard base fields: `timestamp`, `requestId`, `operationName`, `serviceName`.
- Do not include raw key.
- Include `role: "owner" | "joiner"` on caller-scoped events where useful.
- Include `activeCallers` after attach/detach.
- Include `durationMs` for shared completion/failure.
- Include `joinedDurationMs` for caller abort if useful.
- Include `result: "success" | "error" | "aborted"` only as low-cardinality status.
- Include `sharedAborted: boolean` on shared terminal/abort events.
- Include `lastErrorCode?: ResiliErrorCode` only for known Resili errors.

## Metrics Design

Do not implement metrics in the initial runtime phase unless explicitly requested later.

Future metrics:

- `resili_dedupe_misses_total` counter, labels: `service`, `operation`.
- `resili_dedupe_joins_total` counter, labels: `service`, `operation`.
- `resili_dedupe_shared_executions_total` counter, labels: `service`, `operation`, `result`.
- `resili_dedupe_callers_total` counter, labels: `service`, `operation`, `role`, `result`.
- `resili_dedupe_duration_ms` histogram, labels: `service`, `operation`, `scope`, `result`, where `scope` is `shared` or `caller`.
- `resili_dedupe_inflight` gauge, labels: `service`, `operation`.

Never use raw key, `requestId`, URL, error message, stack trace, or user metadata as labels.

## Security Guidance

Dedupe keys are correctness and security boundaries.

Callers must include every input that can affect the result, including tenant, account, locale, authorization scope, feature flags, region, and resource ID.

Unsafe example:

```ts
resili(fetchTenantUser)
  .dedupe({ key: (_tenantId, userId) => userId })
  .build();
```

Safer example:

```ts
resili(fetchTenantUser)
  .dedupe({ key: (tenantId, userId) => `${tenantId}:${userId}` })
  .build();
```

Keys may contain sensitive material. They must not be emitted raw in events, metrics, or error messages.

## Edge Cases

- Two same-key calls in the same microtask: one inserts entry synchronously before starting shared work; the second joins.
- Different keys: separate entries and separate downstream executions.
- Shared success: all active subscribers resolve, entry removed.
- Shared failure: all active subscribers reject, entry removed.
- Key function throws: no entry inserted, no downstream execution.
- Operation throws synchronously: converted to shared promise rejection and delivered to active subscribers.
- Joiner aborts: only joiner rejects/detaches.
- Owner aborts while joiners remain: owner rejects/detaches, shared execution remains active.
- All callers abort: shared execution aborts best-effort if configured, remains observed until settlement.
- Operation ignores abort: entry remains until operation settles, then cleanup runs.
- New caller after completion: creates a new entry and downstream execution.
- New entry for same key before old cleanup finishes: old cleanup must use identity comparison before deletion.
- Joiner arrives during settlement: implementation must settle or miss deterministically; prefer deleting entry within the same settlement microtask.
- Shared mutable result object: all active subscribers receive same reference.

## Risks

- Incorrect key collisions can leak data or return the wrong result.
- Missing tenant/auth scope creates cross-tenant sharing vulnerabilities.
- High-cardinality keys can grow registry size under long-running operations.
- Long-running entries can retain subscribers and context resources until settlement.
- Abandoned callers can leave listeners unless detach cleanup is centralized.
- Cancellation races can double-settle subscribers without per-subscriber state guards.
- Late joiners can inherit near-complete or near-failed shared work.
- Retry amplification can occur after shared failure.
- Hedge multiplication can occur if dedupe is ordered inside hedge.
- Timeout mismatch can cause one caller to stop waiting while shared work continues.
- Shared mutable result objects can be mutated by one caller after resolution.
- A global registry would create memory leaks and cross-client contamination; use per-client only.
- Accidental result retention would create cache semantics; never store settled values beyond immediate settlement.

## Benchmark Plan

Compare without dedupe versus with dedupe.

Workloads:

- 1 caller baseline.
- 10 same-key concurrent callers.
- 100 same-key concurrent callers.
- 1,000 same-key concurrent callers.
- Mixed-key workload with controlled cardinality.
- Successful operation.
- Failing operation.
- Slow operation.
- Caller abort workload.

Measure:

- Downstream execution count.
- Logical caller throughput.
- Mean latency.
- p95 latency.
- p99 latency.
- Memory usage.
- Registry size before, during, and after workload.
- Subscriber attach/detach overhead.
- Event and metric overhead in later observability phase.

## Test Plan

### Validation

- Missing options.
- Missing key.
- Non-function key.
- Invalid `abortSharedWhenUnused`.
- Key function throws.
- Valid string key.
- Valid number key.
- Valid symbol key.
- Invalid key type.
- Null and undefined key rejection.

### Builder and Config

- `.dedupe()` immutable builder snapshot.
- Declarative `createClient(..., { dedupe })` wiring.
- Public exports for `DedupeOptions`, `DedupeKey`, and `dedupePolicy` when implementation phase approves exports.
- Policy order is between timeout and hedge.
- Relative anchors support `before: "dedupe"` and `after: "dedupe"` only if public `PolicyOrder` adds `dedupe` as an anchor.

### Core Sharing

- First caller starts one operation.
- Same-key caller joins.
- 100 same-key calls execute once.
- Different keys execute independently.
- All active callers receive same value.
- All active callers receive same error.
- Entry removed after success.
- Entry removed after failure.
- Later call starts new execution.

### Cancellation

- Joiner abort does not cancel shared execution.
- Owner abort does not cancel shared execution while joiners remain.
- Owner abort rejects only owner.
- All callers abort.
- Shared signal aborted once when unused.
- `abortSharedWhenUnused: false` leaves shared execution running and observed.
- Operation ignores abort and cleanup still occurs after settlement.
- No unhandled rejection.
- Subscriber listeners removed on caller abort and shared settlement.

### Context

- Shared execution gets one child context.
- Logical caller contexts remain independent.
- Parent metadata is not mutated.
- Retry attempt number is preserved.
- Shared context released exactly once.
- Caller contexts are not released by dedupe.

### Concurrency and Races

- Two calls arrive in same microtask.
- Completion and join race.
- Abort and completion race.
- Final caller detaches as shared execution settles.
- Old entry cleanup cannot remove newer entry.
- Registry empty after all work settles.
- No duplicate subscriber settlement.

### Integration

- Dedupe with retry.
- Dedupe with hedge.
- Dedupe with timeout.
- Dedupe with fallback.
- Dedupe with rate limiter.
- Dedupe with bulkhead.
- Dedupe with circuit breaker.

## Expected Implementation Files

Implementation phase should expect changes to:

- `packages/core/src/policies/dedupe/index.ts`
- `packages/core/src/policies/dedupe/index.test.ts`
- `packages/core/src/core/builder/index.ts`
- `packages/core/src/core/builder/index.test.ts`
- `packages/core/src/core/pipeline/index.ts`
- `packages/core/src/core/pipeline/index.test.ts`
- `packages/core/src/core/policy/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/index.test.ts`
- `packages/core/etc/core.api.md`

Potential internal context support may require:

- `packages/core/src/core/context.ts`
- `packages/core/src/core/context.test.ts`

Later observability phases may require:

- `packages/core/src/core/events/index.ts`
- `packages/core/src/core/events/index.test.ts`
- `packages/core/src/core/metrics/index.test.ts`

## Unresolved Questions

1. Can the current `Context` internals create a shared execution context without composing the owner caller's signal, or is a new internal helper required?
2. Should key function errors be wrapped in `ConfigurationError` or propagated as-is? Recommendation: wrap with `field: "dedupe.key"` and `cause`.
3. Should the shared execution deadline be the owner's deadline, earliest active caller deadline, or an internal mutable deadline model? Recommendation for v0.2: owner deadline plus independent caller timeouts, unless an internal context helper supports safe earliest-deadline composition.
4. Should `dedupe` become a public relative policy anchor in `PolicyOrder` immediately? It is likely necessary for consistency once the policy is public.
5. Should symbol keys be documented as process-local only? Recommendation: yes.
6. Should circuit breaker count one observation per logical caller or per shared execution? Recommended order counts per logical caller; this should be explicitly accepted before implementation.

## Phased Implementation Checklist

### Phase 1: Runtime Policy

- Add `DedupeOptions`, `DedupeKey`, and `dedupePolicy` internally.
- Implement option normalization and validation.
- Implement per-client `Map<DedupeKey, InFlightEntry>` registry.
- Implement owner/joiner subscriber lifecycle.
- Implement shared execution context and controller.
- Implement cleanup with identity-checked deletion.
- Add focused runtime tests for sharing, failure, cleanup, and cancellation.

### Phase 2: Builder, Config, and Public API

- Add `.dedupe(options)` to `Builder`.
- Add `dedupe?: DedupeOptions<Args>` or equivalent to `ResiliConfig` after generic review.
- Add `dedupe` to supported config keys.
- Add `dedupe` policy order between timeout and hedge.
- Add public exports and update API report.
- Add builder/config/export/order tests.

### Phase 3: Integration Hardening

- Add retry, timeout, hedge, fallback, rate limiter, bulkhead, and circuit-breaker integration tests.
- Add race tests for join/settle and abort/settle boundaries.
- Add timer/listener/context/promise leak tests.
- Review memory behavior under high subscriber counts.

### Phase 4: Observability

- Add typed dedupe lifecycle events if approved.
- Add low-cardinality dedupe metrics if approved.
- Add observability tests and update API report.

### Phase 5: Documentation and Benchmarks

- Document security keying guidance.
- Document cancellation limitations and mutable result behavior.
- Add benchmark scripts for same-key and mixed-key workloads.
