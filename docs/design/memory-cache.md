# Memory Cache Design

## Status and Scope

Status: design-only proposal for Resili v0.2 feature #3.

This document designs Memory Cache as a first-class Resili policy. It does not implement runtime behavior, builder wiring, exports, events, metrics, package metadata, README changes, changelog changes, website changes, release notes, Redis, distributed coordination, or persistence.

Memory Cache stores successful completed results for a bounded TTL in one built client instance. It is distinct from Request Deduplication:

- Deduplication shares only concurrent in-flight work and never stores completed results.
- Memory Cache stores completed successful values until expiry or eviction and can satisfy later calls without executing downstream policies.

## Problem Statement

Many outbound calls repeatedly fetch the same resource within a short time window:

```text
T0: fetchUser("42") -> downstream
T1: fetchUser("42") -> same value, downstream again
T2: fetchUser("42") -> same value, downstream again
```

For safe read operations where a short-lived value is acceptable, repeated downstream execution wastes latency budget, rate-limit capacity, bulkhead slots, and downstream compute. A Memory Cache policy should allow callers to configure a per-client in-memory TTL cache:

```ts
const client = resili(fetchUser)
  .cache({
    key: (id) => id,
    ttl: 5_000,
  })
  .build();
```

## Goals

- Cache successful results only.
- Scope cache state to one built client instance.
- Use a synchronous key function over the wrapped operation arguments.
- Preserve type inference for `client.call(...args)`.
- Return cached values until TTL expiry.
- Never return expired entries.
- Execute the downstream pipeline on cache miss.
- Store successful downstream results after a miss.
- Avoid timers, listeners, background work, and promise retention.
- Use `services.clock.now()` for deterministic TTL tests.
- Keep cache hits low overhead.
- Avoid raw cache keys in events, metrics, and errors.
- Document security-sensitive keying requirements.
- Fit the existing `PolicyFactory`, builder, pipeline, event, metrics, validation, and public export conventions.

## Non-Goals

- Caching failed values in v0.2.
- Redis, distributed cache, distributed locks, or cross-process coordination.
- Persistent storage.
- User-supplied cache stores in v0.2.
- Stale-while-revalidate.
- Background refresh or refresh-ahead.
- Per-entry timers.
- Custom serializers or key serializers.
- Object-identity keys.
- Async key functions.
- Cache invalidation APIs.
- HTTP cache-control parsing.
- Deep cloning, freezing, or immutability enforcement for cached values.
- Request Deduplication changes beyond the minimal shared operation-argument wiring needed for both policies.

## Repository Findings

- The repository is a `pnpm` monorepo with runtime packages under `packages/*`; `packages/core` owns the policy runtime and public entry point.
- The public entry currently exports policy factories and option types from one package entry: `packages/core/src/index.ts`.
- `createBuilder` captures immutable policy registrations and creates one policy instance per built client in `build()`.
- Client-scoped mutable policy state already lives inside policy instances, as seen in circuit breaker, rate limiter, bulkhead, hedge, and dedupe.
- `createClient` applies declarative config fields to the fluent builder before calling `build()`.
- `PolicyFactory.create(services, options)` validates options at build time and returns an immutable `Policy`.
- `Policy.execute(ctx, next)` is the uniform middleware contract.
- `compilePipeline` sorts by numeric order and composes policies as an onion from lower order to higher order.
- Current built-in order is `fallback:100`, `retry:200`, `circuit-breaker:300`, `timeout:400`, `dedupe:425`, `hedge:450`, `rate-limiter:500`, `bulkhead:600`.
- `PolicyOrder` supports built-in relative anchors and must be updated with any new built-in policy name.
- `Context` is immutable and includes request identity, metadata, signal, deadline, and started time.
- `Context.fork` composes parent signals and deadline; policies that fork contexts must release child contexts with `releaseContext`.
- Cache should not need to fork contexts or attach abort listeners.
- The `Clock` abstraction provides `now`, `setTimeout`, and `clearTimeout`. Cache must use `services.clock.now()` and should not schedule timers.
- `client.call(...args)` currently passes operation arguments to dedupe through internal context metadata when a dedupe policy is installed.
- Cache needs the same operation-argument access, preferably through a shared internal metadata key/helper rather than a cache-specific public `Context` API change.
- Dedupe currently supports `DedupeKey = string | number | symbol` and validates invalid key results with `ConfigurationError`.
- Dedupe key functions receive actual operation arguments and not `Context`.
- Dedupe stores per-client in-flight entries in a `Map`, uses identity-safe cleanup, emits typed events, and records low-cardinality metrics.
- Hedge uses a coordinator, injected clock timers, typed events, low-cardinality metrics, and safe metrics helpers.
- Retry is outside timeout/dedupe/hedge and re-enters downstream policies per attempt.
- Timeout is outside dedupe/hedge/admission and wraps downstream work with an attempt-local abort signal and timer.
- Circuit breaker is outside timeout and observes the result of downstream work on misses.
- Rate limiter and bulkhead are inside dedupe/hedge and should be bypassed by cache hits.
- Fallback is outermost and should remain per logical caller.
- Events use PascalCase names and extend `ResiliEventBase` with `timestamp`, `requestId`, `operationName`, and `serviceName`.
- Metrics use `resili_` snake_case names and low-cardinality labels such as `service` and `operation`; `requestId` and raw keys must never be labels.
- Tests use fake/manual clocks, gates, event arrays, recording metrics, and operation call counts for deterministic behavior.

## Proposed API

Recommended fluent API:

```ts
const client = resili(fetchUser)
  .cache({
    key: (id) => id,
    ttl: 5_000,
  })
  .build();
```

Recommended declarative API:

```ts
const client = createClient(fetchUser, {
  cache: {
    key: (id) => id,
    ttl: 5_000,
  },
});
```

Recommended public types:

```ts
export interface CacheOptions<Args extends readonly unknown[] = readonly unknown[]> {
  readonly key: (...args: Args) => DedupeKey;
  readonly ttl: number;
  readonly cacheUndefined?: boolean;
  readonly cacheNull?: boolean;
  readonly maxEntries?: number;
}
```

Use `DedupeKey` instead of introducing a distinct `CacheKey` in v0.2. Cache and dedupe need the same stable primitive key domain, and reusing the existing public type avoids duplicate API concepts. If future cache-specific constraints diverge, a `CacheKey` alias can be added later without changing the accepted values.

Do not pass `Context` to the key function in v0.2. This keeps the API parallel with dedupe, preserves operation argument inference, and avoids making cache keys depend on mutable execution metadata. If context-sensitive cache keys become necessary, add an explicitly reviewed extension later.

## Option Definitions

### `key`

- Required.
- Synchronous.
- Receives the exact arguments passed to `client.call(...args)`.
- Returns `DedupeKey` (`string | number | symbol`).
- Must not return object, array, function, boolean, bigint, `null`, `undefined`, `NaN`, or infinite number.
- Invalid key results throw `ConfigurationError` with `field: "cache.key"`.
- If the key function itself throws, do not create a cache entry and do not call downstream. Recommended behavior is to propagate the thrown value unchanged, matching current dedupe behavior.
- Raw key values must not be emitted in events, metrics, logs, or error messages.

### `ttl`

- Required.
- Unit: milliseconds.
- Must be a positive finite number greater than `0`.
- `ttl: 0` should be rejected with `ConfigurationError` on `cache.ttl`.
- `NaN`, `Infinity`, negative values, and non-numbers should be rejected.
- Fractional positive TTL values should be accepted because existing timeout/rate-limit validations generally accept finite millisecond numbers unless integer semantics are required.

### `cacheUndefined`

- Optional boolean.
- Default: `false`.
- When false, a successful `undefined` value is returned to the caller but not stored.
- When true, a successful `undefined` value is stored until TTL expiry or eviction.

### `cacheNull`

- Optional boolean.
- Default: `false`.
- When false, a successful `null` value is returned to the caller but not stored.
- When true, a successful `null` value is stored until TTL expiry or eviction.

### `maxEntries`

- Optional positive integer.
- Recommended default: `1_000`.
- This default prevents unbounded memory growth when callers use many unique keys or when expired entries are never looked up again.
- `maxEntries` is a hard entry-count cap per built client and per cache policy instance.
- When exceeded, evict the oldest inserted entry after lazy expiration has run.
- This is FIFO insertion-order eviction, not LRU. Do not refresh recency on cache hit in v0.2.

## Key Model

Supported key types:

```ts
type DedupeKey = string | number | symbol;
```

Rules:

- Use `Map<DedupeKey, CacheEntry<T>>` directly.
- Do not stringify or normalize keys internally.
- `1` and `"1"` are distinct keys.
- Symbols retain identity semantics.
- Object keys are rejected to avoid accidental unbounded cardinality and unstable object identity.
- `null` and `undefined` are rejected rather than treated as "disable caching".

Disabling caching through a sentinel return value is not recommended. It makes key functions ambiguous and increases the chance of silently bypassing protection. Users can conditionally configure clients or include a mode in the key.

## TTL Semantics

Each stored entry has:

```ts
interface CacheEntry<T> {
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
}
```

TTL rules:

- Store `createdAt = services.clock.now()`.
- Store `expiresAt = createdAt + ttl`.
- A cache hit is valid only when `services.clock.now() < expiresAt`.
- A cache entry is expired when `services.clock.now() >= expiresAt`.
- The exact expiry boundary is exclusive: at `now === expiresAt`, the entry must not be returned.
- Use `Math.max(0, now - createdAt)` only for future event/metric durations; expiry comparison should use absolute `expiresAt`.
- If the injected clock moves backward, an entry may appear valid longer than expected. This is acceptable for v0.2 because the `Clock` contract represents wall-clock time and tests should use monotonic fake clocks.
- Do not use `Date.now()`.
- Do not schedule per-entry expiration timers.

`ttl: 0` should be rejected, not treated as "disabled" and not stored as an immediately expired entry. An immediately expired entry adds complexity without useful behavior.

## Policy Ordering

Recommended built-in order, outer to inner:

```text
fallback
-> cache
-> retry
-> circuit-breaker
-> timeout
-> dedupe
-> hedge
-> rate-limiter
-> bulkhead
-> operation
```

Recommended numeric order: `150`, between `fallback:100` and `retry:200`.

### Why Cache Is Outside Retry

Cache hits should not enter retry at all. A hit is a local successful value and has no downstream work to retry. On a miss, retry wraps the downstream execution so a transient failure can retry and the final successful result can be stored by cache.

This means cache stores the eventual successful value after retry, not intermediate failed attempts.

### Why Cache Is Outside Timeout

Cache lookup is synchronous and local. A cache hit should not be subject to per-attempt timeout. A miss proceeds into timeout, and timeout remains responsible for bounding downstream work.

### Why Cache Is Outside Circuit Breaker

Cache hits should bypass an open circuit breaker. Serving a fresh cached value does not contact the unhealthy dependency and can improve resilience during outages. On cache miss or expiry, the circuit breaker applies normally.

Consequence: circuit breaker metrics/state do not observe cache hits. This is intentional because hits are not downstream calls.

### Why Cache Is Outside Dedupe

Recommended relative order is:

```text
cache -> dedupe
```

Cache checks happen first. Hits return immediately. Misses continue to dedupe, so concurrent same-key cache misses can share one downstream execution when both policies are configured.

If dedupe wrapped cache, every cache hit would still create or join a dedupe entry, adding unnecessary in-flight registry work and coupling cache hits to dedupe subscriber behavior.

### Comparison With Prompt Options

Option A:

```text
fallback -> retry -> circuit-breaker -> timeout -> cache -> dedupe -> ...
```

Rejected. Cache hits would still pass through retry, circuit breaker, and timeout. In particular, an open circuit breaker could reject a valid cached value.

Option B:

```text
fallback -> cache -> retry -> circuit-breaker -> timeout -> dedupe -> ...
```

Selected. It allows cache hits to bypass downstream resilience and admission policies, while misses still use the full protected pipeline.

### Built-In Order Table

| Policy          | Order |
| --------------- | ----: |
| fallback        |   100 |
| cache           |   150 |
| retry           |   200 |
| circuit-breaker |   300 |
| timeout         |   400 |
| dedupe          |   425 |
| hedge           |   450 |
| rate-limiter    |   500 |
| bulkhead        |   600 |

Add `"cache"` to public `PolicyOrder` relative anchors during implementation.

## Internal Architecture

Expected policy package:

```text
packages/core/src/policies/cache/index.ts
packages/core/src/policies/cache/index.test.ts
```

Expected internal state:

```ts
interface CacheEntry<T> {
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface CacheStore<T> {
  readonly entries: Map<DedupeKey, CacheEntry<T>>;
}
```

The cache `Map` should be created inside `cachePolicy.create`, so each built client has isolated cache state. Do not use `StateStore` for v0.2 cache entries. `StateStore` is for resilience state and future pluggability, while Memory Cache is explicitly a local per-client completed-value store.

High-level flow:

1. Reject immediately if `ctx.signal.aborted`, using current policy conventions for abort propagation if needed.
2. Resolve and validate the cache key from operation arguments.
3. Read `now = services.clock.now()`.
4. Look up `entry = entries.get(key)`.
5. If entry exists and `now < entry.expiresAt`, return `entry.value`.
6. If entry exists and expired, delete it and continue as a miss.
7. On miss, call `await next(ctx)`.
8. If `next` rejects, do not store and rethrow.
9. If `next` fulfills with `null` and `cacheNull !== true`, return without storing.
10. If `next` fulfills with `undefined` and `cacheUndefined !== true`, return without storing.
11. Store `value` with `createdAt = nowAfterSuccess` and `expiresAt = nowAfterSuccess + ttl`.
12. Run lazy expiration before enforcing `maxEntries`.
13. If size exceeds `maxEntries`, evict oldest inserted entries until within cap.
14. Return the value.

Do not clone stored values. The cache stores and returns the same reference.

## Cache Lifecycle

### Lookup

- Resolve the key once per logical caller.
- Read operation arguments from the same internal metadata mechanism used by dedupe.
- Do not mutate context metadata.
- Do not call downstream on a valid hit.

### Miss

- A missing or expired entry is a miss.
- Expired entries must be deleted before executing downstream.
- Misses execute downstream with the caller's existing context.
- Cache does not create child contexts, timers, listeners, or abort controllers.

### Store

- Store only after downstream fulfills and value passes `cacheNull`/`cacheUndefined` rules.
- If an entry already exists for the key, replace it with the new value and expiry.
- Replacement should update insertion order by deleting the old key before setting the new entry if FIFO eviction depends on `Map` insertion order.

### Expiration

- Expired entries are removed lazily:
  - when their key is looked up;
  - before enforcing `maxEntries` on store;
  - optionally through a bounded sweep on store to avoid large one-call pauses.
- No background cleanup in v0.2.
- No per-entry timers.
- Lazy expiration is sufficient only with `maxEntries` defaulted. Without a cap, stale unique keys could remain forever if never queried again.

### Eviction

- `maxEntries` provides the hard memory bound.
- Eviction should run after removing expired entries.
- Evict oldest inserted entries using `Map` iteration order.
- This is not LRU. Cache hits do not refresh recency.
- Evicted entries are simply removed; no async cleanup is needed.

## Success and Failure Behavior

### Successful Result

- A fulfilled downstream value is eligible for storage.
- `undefined` is stored only when `cacheUndefined: true`.
- `null` is stored only when `cacheNull: true`.
- Other fulfilled values are stored by default.
- The exact fulfilled value reference is returned and stored.

### Failed Result

- Rejections and synchronous throws from downstream are not cached.
- A later same-key call after a failure executes downstream again.
- Fallback results are not cached when using the recommended order because fallback is outside cache.
- v0.2 should not add negative caching or error caching.

### Undefined Result

- Default: return `undefined`, do not store.
- With `cacheUndefined: true`: store and return `undefined` on future hits.
- Tests must distinguish "stored undefined" from "missing entry"; use `Map.has(key)` rather than checking value truthiness.

### Null Result

- Default: return `null`, do not store.
- With `cacheNull: true`: store and return `null` on future hits.

### Mutable Object References

- Cached object values are returned directly.
- No cloning, deep freezing, structural sharing, or serialization occurs.
- If callers mutate a cached object, later callers can observe the mutation.
- This should be documented prominently. Users who need immutable cached values should return immutable objects or clone in their own operation.

## Integration With Dedupe

Recommended order:

```text
cache -> dedupe
```

Behavior:

- Cache hit: returns immediately; dedupe is not entered.
- Cache miss with no concurrent caller: enters dedupe, creates one shared downstream execution, stores success.
- Concurrent same-key misses: each caller checks cache and misses; each enters dedupe; dedupe shares one downstream execution; active callers receive the same value; each cache policy invocation may attempt to store the same value. Last identical replacement wins.
- Concurrent stale entry lookups: the first caller that observes expiry deletes the stale entry; concurrent callers miss and can join dedupe.
- If dedupe is not configured, cache does not deduplicate misses. Concurrent misses may execute downstream concurrently.

Cache and dedupe can reuse the same key function semantics. Users should normally configure both with equivalent key functions when using them together.

Implementation should avoid duplicating operation-argument metadata helpers. The current dedupe-specific internal metadata key should be generalized or shared so both policies receive actual `client.call(...args)` values without exposing `Context` to the public key function.

## Integration With Other Policies

### Fallback

Order: `fallback -> cache`.

- Cache hits bypass fallback because they succeed.
- Cache misses execute downstream inside fallback.
- If downstream eventually fails, fallback handles the terminal error per logical caller.
- Fallback handler results are not cached because fallback is outside cache.
- This avoids accidentally storing degraded fallback values as if they were authoritative downstream data.

### Retry

Order: `cache -> retry`.

- Cache hits bypass retry.
- Cache misses enter retry.
- If retry eventually succeeds, cache stores the final successful result.
- Failed attempts are not cached.
- If retry is exhausted and rejects, cache stores nothing.

### Circuit Breaker

Order: `cache -> retry -> circuit-breaker`.

- Cache hits bypass the circuit breaker, including open-circuit rejection.
- Cache misses are subject to circuit breaker checks.
- Circuit breaker observes only cache misses that execute downstream.
- This reduces breaker sample volume when cache hit rate is high; document this observability trade-off.

### Timeout

Order: `cache -> retry -> circuit-breaker -> timeout`.

- Cache hits bypass timeout.
- Cache misses are bounded by timeout.
- Timeout errors are not cached.
- A timeout followed by retry success can result in the final success being cached by the outer cache policy.

### Hedge

Order: `cache -> dedupe -> hedge`.

- Cache hits bypass hedging.
- Cache misses can dedupe first, then one shared logical execution may hedge internally.
- This avoids multiplying hedge coordinators for concurrent same-key callers.

### Rate Limiter

Order: `cache -> ... -> rate-limiter`.

- Cache hits bypass rate-limit token consumption.
- Cache misses consume rate-limit permits normally.
- This is intentional because hits do not contact downstream.

### Bulkhead

Order: `cache -> ... -> bulkhead`.

- Cache hits bypass bulkhead slots.
- Cache misses consume bulkhead capacity normally.
- Cache can reduce pressure on constrained downstream concurrency.

### Custom Policies

- Custom policies ordered before `cache` see both cache hits and misses.
- Custom policies ordered after `cache` see misses only.
- `"cache"` should be a supported relative-order anchor.

## Events Design

Do not implement events in the first design-only phase. Future typed events should follow existing PascalCase and `ResiliEventBase` conventions.

Recommended future event names:

| Event          | Emitted when                      | Payload                                                              |
| -------------- | --------------------------------- | -------------------------------------------------------------------- |
| `CacheHit`     | Valid entry returned              | `keyType`, `ageMs`, `expiresInMs`                                    |
| `CacheMiss`    | No valid entry is available       | `reason: "missing" \| "expired" \| "skipped"`; `keyType`             |
| `CacheStored`  | Successful value stored           | `keyType`, `ttl`, `expiresAt`, `size`                                |
| `CacheExpired` | Expired entry removed lazily      | `keyType`, `ageMs`                                                   |
| `CacheEvicted` | Entry removed due to `maxEntries` | `keyType`, `reason: "max_entries"`, `size`                           |
| `CacheSkipped` | Successful value not stored       | `reason: "null" \| "undefined" \| "ttl" \| "max_entries"`; `keyType` |

Event rules:

- Include standard base fields: `type`, `timestamp`, `requestId`, `operationName`, `serviceName`.
- Do not include raw keys.
- Do not serialize cached values.
- Do not include tenant/user/account IDs unless they are already part of low-cardinality service/operation names.
- Event listener failures remain isolated by `DefaultEventBus`.

## Metrics Design

Do not implement metrics in the first design-only phase. Future metrics should use `MetricsRecorder` directly and safe helper wrappers consistent with hedge/dedupe.

Recommended metrics:

| Metric                            | Type      | Labels                           | Meaning                                        |
| --------------------------------- | --------- | -------------------------------- | ---------------------------------------------- |
| `resili_cache_hits_total`         | counter   | `service`, `operation`           | Valid cache hits returned                      |
| `resili_cache_misses_total`       | counter   | `service`, `operation`, `reason` | Misses by `missing`, `expired`, or `skipped`   |
| `resili_cache_stores_total`       | counter   | `service`, `operation`, `result` | Store attempts by `stored` or `skipped`        |
| `resili_cache_expired_total`      | counter   | `service`, `operation`           | Expired entries removed lazily                 |
| `resili_cache_evictions_total`    | counter   | `service`, `operation`, `reason` | Evictions, initially `max_entries`             |
| `resili_cache_entries`            | gauge     | `service`, `operation`           | Current entry count per cache policy label set |
| `resili_cache_lookup_duration_ms` | histogram | `service`, `operation`, `result` | Cache lookup overhead by `hit` or `miss`       |

Label rules:

- Never include raw cache keys.
- Never include request IDs.
- Never include URLs, tenant IDs, user IDs, auth scopes, locales, error messages, stack traces, or arbitrary metadata.
- Keep `reason` and `result` as fixed low-cardinality unions.

## Security Guidance

Caching can create data isolation bugs if keys are incomplete.

Key functions must include every dimension that can affect the returned value, including:

- tenant/account/organization;
- authenticated subject or authorization scope;
- locale/language;
- feature flag or experiment cohort;
- region/environment;
- request parameters and filters;
- API version or representation format.

Examples:

```ts
// Unsafe if user ids are scoped by tenant.
cache({ key: (tenantId, userId) => userId, ttl: 5_000 });

// Safer.
cache({ key: (tenantId, userId) => `${tenantId}:${userId}`, ttl: 5_000 });
```

Risks:

- Returning another tenant's cached data.
- Serving data authorized for one user to a different user.
- Serving stale authorization-sensitive state after permissions change.
- Retaining sensitive objects in memory longer than intended.
- Accidental high-cardinality memory growth through unbounded keys.

Raw keys may contain sensitive identifiers and must never appear in events or metrics.

## Edge Cases

- Missing options: `ConfigurationError` on `cache`.
- Missing `key`: `ConfigurationError` on `cache.key`.
- Missing `ttl`: `ConfigurationError` on `cache.ttl`.
- Key function throws: propagate thrown value; do not execute downstream or store.
- Invalid key result: `ConfigurationError` on `cache.key`; do not execute downstream or store.
- `ttl: 0`: reject; do not silently disable caching.
- `now === expiresAt`: expired.
- Expired entry exists: delete and execute downstream.
- Downstream failure: do not store.
- Downstream success with `undefined`: skip unless `cacheUndefined`.
- Downstream success with `null`: skip unless `cacheNull`.
- Different keys: isolated entries.
- Same key with different arguments: intentionally shares a cached value; this is user responsibility.
- Replacement: later successful miss for same key replaces older entry.
- Max entries exceeded: remove expired entries first, then evict oldest inserted entries.
- Operation ignores abort: cache sees only the final fulfilled/rejected result of the miss path.
- Parent abort before cache hit: open question; recommended behavior is to respect current pipeline semantics and reject before returning a hit if `ctx.signal.aborted` is already true.
- Parent abort during downstream miss: downstream policies handle abort; cache stores nothing if the miss rejects.

## Risks

- Incorrect keying can leak data across tenants/users.
- Mutable cached objects can be modified by callers.
- Cache hits bypass circuit breaker, rate limiter, bulkhead, timeout, and hedge; this is intended but changes observability and admission counts.
- A high-cardinality key space can retain many values until TTL/eviction.
- FIFO eviction may evict a frequently used key under large key churn; LRU is intentionally out of v0.2 scope.
- Cache outside retry means one logical call can run all retries before storing; this is desirable but should be tested.
- Cache outside circuit breaker means fresh cached data can be served while circuit is open; generally desirable but must be documented.
- Clock changes can affect TTL.
- `symbol` keys are valid but difficult to reproduce across call sites unless the same symbol instance is reused.

## Benchmark Plan

Compare a representative operation without cache versus with cache.

Measure:

- downstream execution count;
- cache hit latency;
- cache miss latency;
- throughput under high hit rate;
- throughput under low hit rate;
- memory usage by number of retained entries;
- cost of lazy expiration;
- cost of `maxEntries` eviction;
- mixed-key workload;
- concurrent same-key workload with dedupe enabled;
- concurrent same-key workload without dedupe enabled;
- overhead with `noopMetrics`;
- overhead after future metrics are enabled with an in-memory recorder.

Scenarios:

- 100% misses.
- 100% hits after warmup.
- 90/10 hit/miss mixed workload.
- High-cardinality churn above `maxEntries`.
- Expired-entry sweep workload.
- Concurrent same-key misses with `cache -> dedupe`.
- Concurrent different-key misses.

## Test Plan

### Validation

| Scenario                                     | Expected                                          |
| -------------------------------------------- | ------------------------------------------------- |
| Missing options                              | `ConfigurationError` field `cache`                |
| `null`, array, or non-object options         | `ConfigurationError` field `cache`                |
| Missing `key`                                | `ConfigurationError` field `cache.key`            |
| Non-function `key`                           | `ConfigurationError` field `cache.key`            |
| Missing `ttl`                                | `ConfigurationError` field `cache.ttl`            |
| `ttl: 0`                                     | `ConfigurationError` field `cache.ttl`            |
| Negative, `NaN`, infinite, or non-number TTL | `ConfigurationError` field `cache.ttl`            |
| Non-boolean `cacheUndefined`                 | `ConfigurationError` field `cache.cacheUndefined` |
| Non-boolean `cacheNull`                      | `ConfigurationError` field `cache.cacheNull`      |
| Invalid `maxEntries`                         | `ConfigurationError` field `cache.maxEntries`     |
| Invalid key result                           | `ConfigurationError` field `cache.key`            |
| Key function throws                          | thrown value propagates; downstream not called    |

### Core Behavior

| Scenario                           | Expected                                         |
| ---------------------------------- | ------------------------------------------------ |
| First call                         | miss; downstream executes                        |
| Second same-key call before expiry | hit; downstream not called                       |
| Different keys                     | isolated downstream executions                   |
| Expiry before second call          | expired entry deleted; downstream executes again |
| Exact expiry boundary              | `now === expiresAt` is miss                      |
| Successful replacement             | new value replaces old value                     |
| Downstream failure                 | not cached                                       |
| Failure then success               | second call executes and stores success          |
| `undefined` default                | not cached                                       |
| `undefined` with `cacheUndefined`  | cached                                           |
| `null` default                     | not cached                                       |
| `null` with `cacheNull`            | cached                                           |
| Mutable object                     | same reference returned; behavior documented     |

### Clock

| Scenario                | Expected                                 |
| ----------------------- | ---------------------------------------- |
| Manual clock before TTL | hit                                      |
| Manual clock at TTL     | miss                                     |
| Manual clock after TTL  | miss                                     |
| No wall-clock sleeps    | all tests use fake/manual clock          |
| Clock moves backward    | no crash; expiry uses stored `expiresAt` |

### Integration

| Policy          | Scenario                           | Expected                                               |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| Dedupe          | concurrent same-key misses         | one shared downstream execution when dedupe configured |
| Dedupe          | cache hit                          | dedupe not entered                                     |
| Retry           | miss fails then retries to success | final success stored                                   |
| Retry           | retry exhausted                    | no cache entry                                         |
| Timeout         | miss times out                     | no cache entry                                         |
| Timeout         | hit                                | timeout not entered                                    |
| Circuit breaker | hit while circuit open             | hit returns without breaker rejection                  |
| Circuit breaker | miss                               | breaker applies normally                               |
| Hedge           | hit                                | no hedge attempts                                      |
| Hedge           | miss                               | hedge applies normally after dedupe                    |
| Rate limiter    | hit                                | no token consumed                                      |
| Rate limiter    | miss                               | token consumed                                         |
| Bulkhead        | hit                                | no slot consumed                                       |
| Bulkhead        | miss                               | slot consumed                                          |
| Fallback        | downstream failure                 | fallback result returned but not cached                |

### Cleanup

| Scenario                                 | Expected                                          |
| ---------------------------------------- | ------------------------------------------------- |
| Expired key lookup                       | entry deleted lazily                              |
| Store after many expired entries         | expired entries removed before max-entry eviction |
| `maxEntries` exceeded                    | oldest inserted entry evicted                     |
| No timers                                | no timer handles allocated by cache               |
| No listeners                             | no abort listeners attached by cache              |
| No promise retention                     | cache stores values only, not promises            |
| Store size after expiration and eviction | bounded by `maxEntries`                           |

### Events and Metrics Later

Add tests in later observability phase for:

- `CacheHit`, `CacheMiss`, `CacheStored`, `CacheExpired`, `CacheEvicted`, `CacheSkipped`;
- low-cardinality metric increments;
- no raw key/requestId labels;
- metric recorder failures do not affect behavior.

## Expected Implementation Files

Phase 1 policy-only:

- `packages/core/src/policies/cache/index.ts`
- `packages/core/src/policies/cache/index.test.ts`

Phase 2 public wiring:

- `packages/core/src/core/builder/index.ts`
- `packages/core/src/core/builder/index.test.ts`
- `packages/core/src/core/client/index.ts` if operation-argument metadata wiring needs generalization
- `packages/core/src/core/pipeline/index.ts`
- `packages/core/src/core/pipeline/index.test.ts`
- `packages/core/src/core/policy/index.ts`
- `packages/core/src/core/policy/index.test.ts`
- `packages/core/src/index.ts`
- `packages/core/src/index.test.ts`
- `packages/core/etc/core.api.md`

Phase 3 observability:

- `packages/core/src/core/events/index.ts`
- `packages/core/src/core/events/index.test.ts`
- `packages/core/src/policies/cache/index.ts`
- `packages/core/src/policies/cache/index.test.ts`
- `packages/core/etc/core.api.md`

Documentation after implementation approval:

- user-facing docs to be selected later;
- README/changelog/website only during release documentation phase, not implementation phases.

## Unresolved Questions

- Should the default `maxEntries` be `1_000`, `10_000`, or another value?
- Should `maxEntries` be required instead of defaulted?
- Should cache expose a future `shouldCache(value, ctx)` predicate, or are `cacheNull`/`cacheUndefined` enough for v0.2?
- Should key function throws be wrapped in `ConfigurationError` or propagated unchanged? Recommendation: propagate unchanged to match current dedupe behavior.
- Should cache hits respect an already-aborted parent signal, or may they return because no downstream work is needed? Recommendation: reject if `ctx.signal.aborted` at policy entry for consistency with cancellation-first internals.
- Should `symbol` keys be allowed for cache because dedupe allows them, or should cache restrict to `string | number` for easier diagnostics? Recommendation: reuse `DedupeKey`.
- Should future `CacheSkipped` include a reason for `cacheNull`/`cacheUndefined`, or is that too verbose?
- Should FIFO eviction be enough, or should LRU be introduced before public release? Recommendation: FIFO for v0.2.

## Phased Implementation Checklist

### Phase 1: Policy-Only Runtime

- Add `packages/core/src/policies/cache/index.ts`.
- Add `CacheOptions`.
- Reuse `DedupeKey`.
- Add `cachePolicy` factory with order `150`.
- Normalize and validate options.
- Implement per-policy-instance `Map`.
- Implement key resolution from operation-argument metadata.
- Implement TTL lookup and exact boundary behavior.
- Implement lazy expiration.
- Implement `maxEntries` FIFO eviction.
- Store successful values only.
- Skip failed, `null`, and `undefined` values according to options.
- Add focused policy tests with manual clock.

### Phase 2: Public Wiring

- Add `.cache(options)` to `Builder`.
- Add `cache?: CacheOptions<Args>` to `ResiliConfig`.
- Add config validation support.
- Add `cache` to built-in order and relative anchors.
- Generalize operation-argument metadata wiring so cache and dedupe both receive actual call arguments.
- Export `CacheOptions` and `cachePolicy` if policy factories remain public.
- Update API report.
- Add builder/config/export/order tests.

### Phase 3: Integration and Hardening

- Add integration tests for cache with dedupe, retry, timeout, circuit breaker, hedge, rate limiter, bulkhead, and fallback.
- Add cleanup tests for expired entries and `maxEntries`.
- Review memory retention.
- Review mutable reference behavior.
- Review operation-argument metadata sharing.
- Run full validation.

### Phase 4: Observability

- Add typed cache events.
- Add low-cardinality cache metrics.
- Add event/metric tests.
- Update API report.

### Phase 5: Documentation and Benchmarks

- Add user-facing documentation.
- Add security/keying guidance.
- Add benchmark scenarios and results.
- Update release notes/changelog only in release phase.

## Validation Commands

For this design-only phase:

```bash
pnpm exec prettier --check docs/design/memory-cache.md
git diff --check -- docs/design/memory-cache.md
```

For implementation phases:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm api:check
```
