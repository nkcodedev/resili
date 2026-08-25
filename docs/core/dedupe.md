# Dedupe

Collapses concurrent same-key calls into a single downstream execution.

**Pipeline position:** order `425` — inside timeout, outside hedge and admission control.

> Not listed in the original documentation plan, but `dedupePolicy` is exported public API and is
> configurable through the `dedupe` config key, so it is documented here.

## When to use it

For read amplification: fifty requests arriving in the same tick for the same resource, a cold cache
being stampeded, a fan-out that resolves the same reference repeatedly. Dedupe answers all of them
with one downstream call.

The distinction from [cache](cache.md) matters: dedupe shares work that is **in flight**; it never
retains a completed result. Two sequential calls for the same key execute twice. Use dedupe for
single-flight behavior and cache for reuse over time — they compose well.

## Configuration

```ts
interface DedupeOptions<Args extends readonly unknown[]> {
  readonly key: (...args: Args) => string | number | symbol;
  readonly abortSharedWhenUnused?: boolean;
}
```

| Option                  | Default  | Notes                                                         |
| ----------------------- | -------- | ------------------------------------------------------------- |
| `key`                   | required | Derives the dedupe key from the operation's arguments.        |
| `abortSharedWhenUnused` | `true`   | Abort the shared execution when the last subscriber detaches. |

## Behavior

The first caller for a key becomes the **owner**: a shared `AbortController` and a coordinator-owned
context are created, and the downstream work starts once. Later callers arriving while that work is
in flight become **joiners** and attach to the same promise.

When the shared execution settles, every subscriber receives the same resolution or the same
rejection, and the registry entry is removed. Nothing is retained for future calls.

The shared work runs on the **coordinator's** context, not the owner's. It carries the owner's
`requestId`, `attemptNumber`, and metadata, but its signal is the shared controller's — which is why
one caller cancelling does not cancel the others.

## Cancellation

This is the interesting part of the policy.

- Each caller's cancellation detaches **only that caller**. Owner and joiner are symmetric here;
  the owner leaving does not abandon the joiners.
- With `abortSharedWhenUnused: true` (the default), if the last active subscriber detaches before the
  work settles, the shared execution is aborted — nobody is waiting, so the work is pointless.
- With `abortSharedWhenUnused: false`, the shared work continues to completion even with zero
  subscribers. Choose this when the operation has a useful side effect, such as warming a cache.
- A caller that is already aborted on arrival never joins and never starts downstream work.

## Errors

Dedupe raises `ConfigurationError` for invalid options or an invalid runtime key. A shared failure is
delivered to every subscriber — the same error instance, not a copy. Subscribers still waiting when
the entry is cleaned up receive an `AbortError`.

Because failures are shared but not retained, a subsequent call for the same key starts fresh
downstream work rather than replaying the failure.

## Interaction with other policies

- **Retry** is outside dedupe, so deduplication applies within a single attempt. A new retry attempt
  can deduplicate again against whatever is in flight at that point.
- **Rate limiter** and **bulkhead** are inside, so joiners consume **no** additional permits and
  **no** additional slots — one shared execution, one permit. This is a large part of dedupe's value
  under load.
- **Fallback** is outside, so each caller runs its own fallback handler even though the shared
  execution failed once.
- **Cache** is outside and does not deduplicate concurrent misses on its own. Pair them.

## Events and metrics

Events: `DedupeMiss`, `DedupeJoined`, `DedupeCompleted`, `DedupeFailed`, `DedupeCallerAborted`,
`DedupeSharedAborted`.

Metrics: `resili_dedupe_misses_total`, `resili_dedupe_joins_total`, `resili_dedupe_callers_total`,
`resili_dedupe_shared_executions_total`, `resili_dedupe_duration_ms`,
`resili_dedupe_join_wait_ms`, and `resili_dedupe_inflight`. See
[Metrics](../observability/metrics.md).

## Example

Single-flight in front of a TTL cache — the canonical pairing:

```ts
import { createClient } from "@resili/core";

const profile = createClient(async (userId: string) => fetchProfile(userId), {
  cache: { key: (userId: string) => userId, ttl: 10_000 },
  dedupe: { key: (userId: string) => userId },
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  bulkhead: { maxConcurrent: 10 },
});

// One downstream call, one bulkhead slot, 50 resolved promises.
await Promise.all(Array.from({ length: 50 }, () => profile.call("u-1")));
```

## Limitations

- In-flight only; completed results are never retained.
- In-memory and per client instance.
- Keys must be a `string`, finite `number`, or `symbol`.
- The shared execution's context is coordinator-owned, so per-caller metadata differences are not
  reflected downstream — the owner's metadata is what the operation sees.
- Only safe when the operation is genuinely shareable. Do not deduplicate calls whose result depends
  on caller identity unless that identity is part of the key.
