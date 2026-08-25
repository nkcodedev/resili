# Policy pipeline

How Resili turns a set of configured policies into one composed function.

For usage-oriented guidance — which anchor to choose, why the default order is what it is — see
[Policy ordering](../core/policy-ordering.md). This page covers the mechanism.

## The policy contract

```ts
interface Policy {
  readonly name: string;
  readonly order: PolicyOrder;
  execute<T>(ctx: Context, next: Next<T>): Promise<T>;
}

type Next<T> = (ctx: Context) => Promise<T>;
```

Every policy receives the context and a `next` continuation. It may call `next` once, several times
(retry, hedge), or not at all (a cache hit, an open breaker). It may pass the context through
unchanged or fork it (timeout, retry, hedge).

That single signature is why policies compose without knowing about each other.

## Compilation

Building a client compiles the pipeline once:

1. Instantiate each configured policy through its factory, validating options eagerly.
2. Resolve every policy's `order` to a number.
3. Sort ascending, preserving registration order for ties.
4. Fold the array from the end inward, wrapping the operation.

```ts
let chain: Next<T> = operation;

for (let i = policies.length - 1; i >= 0; i--) {
  const policy = policies[i];
  const next = chain;
  chain = (ctx) => policy.execute(ctx, next);
}
```

Because the fold runs backwards, **the lowest order number ends up outermost**. Compilation happens
at build time, not per request, so calls pay no composition cost.

## Order resolution

```ts
type PolicyOrder =
  number | { readonly before: BuiltinPolicyName } | { readonly after: BuiltinPolicyName };
```

Built-in anchors:

| Name              | Order |
| ----------------- | ----- |
| `fallback`        | 100   |
| `cache`           | 150   |
| `retry`           | 200   |
| `circuit-breaker` | 300   |
| `timeout`         | 400   |
| `dedupe`          | 425   |
| `hedge`           | 450   |
| `rate-limiter`    | 500   |
| `bulkhead`        | 600   |

Relative anchors resolve to the anchor ± `0.5`: `{ before: "retry" }` is `199.5`,
`{ after: "cache" }` is `150.5`. An unresolvable order — an unknown anchor or a malformed value —
becomes `Number.MAX_SAFE_INTEGER`, placing the policy innermost rather than throwing.

The gaps between built-in numbers are intentional. Spacing of 50–100 leaves room for future built-ins
and for custom policies using absolute numbers, without renumbering anything.

`@resili/llm`'s Budget Guard uses `{ before: "retry" }` — one reservation per logical request rather
than one per attempt.

## Registration

| Mechanism          | API                                                         |
| ------------------ | ----------------------------------------------------------- |
| Custom policy      | `definePolicy(factory)`                                     |
| Fluent builder     | `builder.policy(factory, options?)`                         |
| Declarative config | `createClient(op, { policies: [{ factory, options? }] })`   |
| Plugin             | `builder.use(plugin, options?)` → `ctx.registerPolicy(...)` |

A plugin's `priority` orders **setup** only. Runtime order is always the policy's `order` — a plugin
cannot reorder the pipeline by installing earlier.

## Request lifecycle

```text
Client.call(args)
  ├─ create root context     requestId, deadline, composed signal, metadata
  ├─ emit RequestStarted
  ├─ run the compiled chain
  │    each policy: observe / fork / short-circuit / delegate
  └─ emit RequestCompleted   durationMs, status, attempts, errorCode?
```

`RequestStarted` and `RequestCompleted` come from the pipeline itself, not from a policy, so they
bracket the whole logical call regardless of which policies are configured. `attempts` on completion
is where the real cost of retries becomes visible.

Listener exceptions are caught by the event bus and never propagate into execution.

## Composition properties

**Nesting, not chaining.** Each policy wraps the rest, so an outer policy can run code before _and_
after everything beneath it. Retry loops over the entire inner stack; fallback catches whatever the
whole stack throws.

**Re-entrancy.** A policy that calls `next` more than once re-enters every inner policy. Each retry
attempt gets a fresh timeout timer and re-acquires rate limiter and bulkhead permits. This is why
`retry × hedge` multiplies downstream calls.

**Short-circuiting.** Not calling `next` skips everything below. A cache hit consumes no permit,
occupies no slot, and records nothing in the breaker window.

**Errors propagate unwrapped.** A policy rethrows a downstream error as the same instance unless it
has something to add. Only `RetryExceededError` wraps — and it preserves the original on `lastError`
and as `cause`. Type checks work across the whole stack.

**Context flows down, never up.** Forks are one-directional: a child sees the parent's cancellation,
but aborting a child never affects the parent. That asymmetry is exactly what makes per-attempt
timeouts work.

## Writing a policy

```ts
import { definePolicy } from "@resili/core";

export const tracingPolicy = definePolicy({
  name: "tracing",
  order: { before: "retry" }, // one span per logical call
  create() {
    return {
      name: "tracing",
      order: { before: "retry" },
      async execute(ctx, next) {
        const span = tracer.start(ctx.operationName, { requestId: ctx.requestId });
        try {
          const result = await next(ctx);
          span.end("ok");
          return result;
        } catch (error) {
          span.end("error");
          throw error; // rethrow the same instance
        }
      },
    };
  },
});
```

Four rules that keep a custom policy well-behaved:

1. **Rethrow the original error** unless you have a reason to wrap. Wrapping breaks `instanceof`
   checks for every policy above you.
2. **Validate options in `create`**, not in `execute`. Misconfiguration should fail at build time.
3. **Fork rather than mutate** the context, and pass `attemptNumber` explicitly — the default is
   _parent + 1_.
4. **Use the injected `Clock`** for any timing, so the policy stays testable.

## Limitations

- Order is a single scalar; there is no dependency graph or constraint solver.
- The chain is compiled at build time and cannot be modified per request.
- Relative anchors reference only built-in names, so a custom policy cannot anchor to another custom
  policy.
- Anchor collisions are resolved by registration order, which can be surprising when two custom
  policies use the same anchor.
- `PolicyServices` (clock, classifier, store, events, metrics) is the only injection seam available to
  a policy.
