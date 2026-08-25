# Cache

Stores successful results in a per-client in-memory map for a fixed TTL.

**Pipeline position:** order `150` — second only to fallback, and crucially **outside retry**.

## When to use it

For reads that are expensive and tolerate staleness. Because the cache sits near the top of the
pipeline, a hit is close to free: it skips retry, the circuit breaker, the timeout, admission
control, and the operation itself.

Do not use it for writes, for per-user data keyed carelessly, or as a correctness mechanism.

## Configuration

```ts
interface CacheOptions<Args extends readonly unknown[]> {
  readonly key: (...args: Args) => string | number | symbol;
  readonly ttl: number;
  readonly cacheUndefined?: boolean;
  readonly cacheNull?: boolean;
  readonly maxEntries?: number;
}
```

| Option           | Default  | Notes                                                 |
| ---------------- | -------- | ----------------------------------------------------- |
| `key`            | required | Derives the cache key from the operation's arguments. |
| `ttl`            | required | Milliseconds, finite and `> 0`.                       |
| `cacheUndefined` | `false`  | Whether `undefined` results are stored.               |
| `cacheNull`      | `false`  | Whether `null` results are stored.                    |
| `maxEntries`     | `1000`   | Capacity before eviction. Positive integer.           |

The key must be a `string`, a finite `number`, or a `symbol`. An invalid key raises a
`ConfigurationError` with `field: "cache.key"` at call time, not build time, because it depends on
the arguments.

## Behavior

1. If the context is already aborted, the policy throws before resolving the key or touching the map.
2. The key is derived from the operation arguments.
3. **Hit** (present and unexpired): emit `CacheHit` and return the stored value. `next(ctx)` is never
   called.
4. **Miss** (absent, or present but expired): delete any expired entry, emit the miss, and call
   `next(ctx)`.
5. On success, store the value with `expiresAt = now + ttl` — unless it is `null` or `undefined` and
   the corresponding flag is off, in which case `CacheSkipped` is emitted.
6. Failures propagate unchanged and are **not** cached.

Expiry is passive: there are no timers or background sweeps. An expired entry is discovered and
removed the next time its key is looked up.

Eviction at capacity is **FIFO by insertion order, not LRU** — reading an entry does not make it
newer. Overwriting a key does move it to the newest position. Expired entries are cleaned before a
capacity eviction is considered.

Falsy values are cached normally: `false`, `0`, and `""` are stored by default. Only `null` and
`undefined` are gated.

## Cache placement, and what a hit skips

```text
fallback
  cache        ◀── a hit returns here
    retry
      circuit-breaker
        timeout
          dedupe / hedge / rate-limiter / bulkhead
            operation
```

A hit consumes no rate limiter permit, occupies no bulkhead slot, records nothing in the breaker
window, and starts no timeout timer. A miss continues into the full pipeline as normal.

This also means the cache stores whatever the pipeline produced — including a value that came from a
[fallback](fallback.md), since fallback is outside the cache. Be deliberate about combining the two.

## Errors

The cache raises no errors of its own beyond `ConfigurationError` for invalid options or an invalid
runtime key. Downstream failures pass through untouched.

## AbortSignal

The signal is checked **once**, before the lookup. An already-aborted call never resolves a key or
invokes the operation. The cache does not register abort listeners and does not interrupt an
in-progress miss.

## Interaction with other policies

- **Retry** is inside, so retries only ever happen on a miss.
- **Dedupe** is inside and independent: the cache does **not** collapse concurrent misses. Two
  simultaneous misses for the same key both call the operation. Add [dedupe](dedupe.md) if you need
  single-flight behavior.
- **Fallback** is outside, so a fallback value can be cached.

## Events and metrics

Events: `CacheHit`, `CacheMiss`, `CacheStored`, `CacheExpired`, `CacheEvicted`, `CacheSkipped`. Cache
keys are not included in event payloads.

The cache is one of only three policies that record metrics — `resili_cache_hits_total`,
`resili_cache_misses_total`, `resili_cache_stores_total`, `resili_cache_skipped_total`,
`resili_cache_expired_total`, `resili_cache_evictions_total`, `resili_cache_entries`, and
`resili_cache_lookup_duration_ms`. See [Metrics](../observability/metrics.md).

## Example

```ts
import { createClient } from "@resili/core";

const catalog = createClient(async (sku: string) => fetchProduct(sku), {
  cache: { key: (sku: string) => sku, ttl: 30_000, maxEntries: 5_000 },
  dedupe: { key: (sku: string) => sku }, // collapse concurrent misses
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 2, jitter: "none" },
});
```

## Limitations

- In-memory and per client instance. Nothing is shared between processes, and everything is lost on
  restart.
- Concurrent misses are not deduplicated by the cache itself.
- FIFO eviction, not LRU — a hot key can be evicted while colder, newer keys survive.
- Hard expiry only. There is no stale-while-revalidate, background refresh, or serve-stale-on-error.
- No manual invalidation API; you cannot delete or clear a key.
- Values are stored by reference and are not cloned or frozen. Mutating a returned object mutates the
  cached entry.
