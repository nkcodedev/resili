# Policy ordering

Resili composes policies as an onion. Order is part of the contract, not an implementation detail:
the same set of policies in a different order produces genuinely different behavior.

## The default order

Every built-in policy carries a numeric `order`. Policies are sorted ascending, and the chain is
built from the inside out, so **the lowest number is the outermost layer**.

| Order | Policy                                | Config key       |
| ----- | ------------------------------------- | ---------------- |
| 100   | [Fallback](fallback.md)               | `fallback`       |
| 150   | [Cache](cache.md)                     | `cache`          |
| 200   | [Retry](retry.md)                     | `retry`          |
| 300   | [Circuit breaker](circuit-breaker.md) | `circuitBreaker` |
| 400   | [Timeout](timeout.md)                 | `timeout`        |
| 425   | [Dedupe](dedupe.md)                   | `dedupe`         |
| 450   | [Hedge](hedge.md)                     | `hedge`          |
| 500   | [Rate limiter](rate-limiter.md)       | `rateLimiter`    |
| 600   | [Bulkhead](bulkhead.md)               | `bulkhead`       |

```text
fallback
└── cache
    └── retry
        └── circuit-breaker
            └── timeout
                └── dedupe
                    └── hedge
                        └── rate-limiter
                            └── bulkhead
                                └── operation      ◀── innermost
```

The operation is always innermost — it is the function you wrapped, not a policy.

Only the policies you configure appear in the chain. Configuring just `retry` and `timeout` yields
`retry → timeout → operation`; the relative order of the ones present is unchanged.

### With `@resili/llm`

The LLM Budget Guard is not a core policy. It registers itself with the relative anchor
`{ before: "retry" }`, resolving to order `199.5` — between cache and retry:

```text
fallback → cache → llm-budget → retry → circuit-breaker → timeout → … → provider
```

That placement is deliberate: one budget reservation covers the whole logical request, so retries do
not each reserve budget. See [Budget Guard](../llm/budget-guard.md).

## Why the order matters

### Retry outside timeout

This is the ordering Resili uses.

```text
retry
└── timeout (perAttemptMs)
    └── operation
```

Each attempt gets a **fresh** timer. `perAttemptMs: 1000` with `maxAttempts: 3` means three chances
of up to one second each, so the worst case is about three seconds plus backoff delays. A single slow
attempt is cut off and retried, which is usually what you want: the point of a per-attempt timeout is
to give up on _this_ attempt, not on the request.

### Timeout outside retry

Resili does **not** do this. If it did:

```text
timeout (overall)
└── retry
    └── operation
```

one timer would bound the entire retry sequence. Attempt one could consume the whole budget and no
retry would ever get a chance — the timeout would fire mid-attempt-one and the call would fail
without ever exercising the retry policy.

Both semantics are legitimate; they answer different questions. Resili answers "how long may one
attempt take?" with `perAttemptMs`. For "how long may the whole request take?", use the context
deadline, which every policy respects through the composed signal. `TimeoutOptions.deadlineMs` is
rejected; it is not the way to get an overall bound.

### Cache outside retry

A hit returns before retry, the breaker, the timeout, and admission control are involved. Cached
reads cost essentially nothing and consume no permits.

Turned around — cache inside retry — every retry attempt would re-check the cache, which is pointless
work since a miss on attempt one is still a miss on attempt two.

### Circuit breaker inside retry

`CircuitOpenError` is classified as non-retryable, so an open breaker ends the retry loop on the
first attempt instead of burning all three attempts on a dependency that is known to be down. The
breaker also observes each retry attempt individually, so its failure window reflects real call
volume.

### Admission control innermost

The rate limiter and bulkhead sit closest to the operation, so they gate actual downstream calls
rather than logical requests. Two consequences worth knowing: a retry attempt re-acquires a permit,
and dedupe joiners — being _outside_ both — consume neither a permit nor a slot.

## Custom policies

Register a custom policy with an absolute order or a relative anchor.

```ts
import { definePolicy, resili } from "@resili/core";

const tracing = definePolicy({
  name: "tracing",
  order: { before: "retry" }, // outside retry: one span per logical call
  create() {
    return {
      name: "tracing",
      order: { before: "retry" },
      async execute(ctx, next) {
        return await withSpan(ctx.operationName, () => next(ctx));
      },
    };
  },
});

const client = resili(operation).policy(tracing).build();
```

`PolicyOrder` accepts three forms:

```ts
type PolicyOrder =
  number | { readonly before: BuiltinPolicyName } | { readonly after: BuiltinPolicyName };
```

The anchor names are the built-in policy names exactly as they appear in the table above:
`"fallback"`, `"cache"`, `"retry"`, `"circuit-breaker"`, `"timeout"`, `"dedupe"`, `"hedge"`,
`"rate-limiter"`, `"bulkhead"`.

A relative anchor resolves to the anchor's order ± `0.5`, so `{ before: "retry" }` is `199.5` and
`{ after: "cache" }` is `150.5`. Both land between cache and retry, with `{ after: "cache" }` the
outer of the two.

Ties preserve registration order. A policy whose order cannot be resolved — an unknown anchor, or a
malformed value — sorts last, placing it innermost.

### Choosing an anchor

The question to ask is "how many times should this run?"

| Intent                             | Anchor                         |
| ---------------------------------- | ------------------------------ |
| Once per logical call              | `{ before: "retry" }` or outer |
| Once per attempt                   | `{ after: "retry" }` or inner  |
| Inside the per-attempt time budget | `{ after: "timeout" }`         |
| Around admission control           | `{ before: "rate-limiter" }`   |

Logging placed inside retry logs every attempt; placed outside retry it logs one line per request.
Neither is wrong, but they are not interchangeable.

## Plugins

`definePlugin` bundles policy registration, event subscriptions, and service overrides. A plugin's
`priority` orders **setup** only — it has no effect on runtime policy order, which is always governed
by each policy's `order`.

```ts
import { definePlugin, resili } from "@resili/core";

const audit = definePlugin({
  name: "audit",
  version: "1.0.0",
  apiVersion: "1.0.0",
  setup(ctx) {
    ctx.on("RequestCompleted", (event) => log(event.operationName, event.status));
    ctx.registerPolicy(tracing);
    return { name: "audit" };
  },
});

const client = resili(operation).use(audit).build();
```

Plugins are disposed in reverse installation order when `client.destroy()` is called.

## Further reading

- [Policy pipeline architecture](../architecture/policy-pipeline.md) — how the chain is compiled
- [Execution context](execution-context.md) — what flows between layers
- [Cancellation](cancellation.md) — how aborts travel through the onion
