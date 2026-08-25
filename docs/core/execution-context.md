# Execution context

The `Context` is the immutable per-execution state threaded through every policy and handed to your
operation. It carries identity, the attempt number, cancellation, the deadline, and metadata.

## Shape

```ts
interface Context {
  readonly requestId: string;
  readonly operationName: string;
  readonly serviceName: string;
  readonly attemptNumber: number;
  readonly metadata: ReadonlyMap<string, unknown>;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly startedAt: number;
  fork(patch: ContextForkPatch): Context;
  snapshot(): ContextSnapshot;
}
```

| Field           | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`     | Identifies one **logical** call. Stable across every retry attempt.                                                                     |
| `operationName` | Logical operation name. Defaults to `"operation"`.                                                                                      |
| `serviceName`   | Logical dependency name. Defaults to `"default"`, and is the default partition key for the circuit breaker, rate limiter, and bulkhead. |
| `attemptNumber` | 1-based attempt counter. Incremented by retry.                                                                                          |
| `metadata`      | Read-only key/value bag for cross-cutting values.                                                                                       |
| `signal`        | Composed cancellation signal — caller abort, deadline, and per-attempt timeout.                                                         |
| `deadline`      | Absolute time budget for the logical call. Defaults to `Number.POSITIVE_INFINITY`.                                                      |
| `startedAt`     | Clock time at root context creation.                                                                                                    |

`requestId` versus `attemptNumber` is the distinction to internalize: one `requestId` may span several
attempts. Correlate logs by `requestId`, and distinguish attempts by `attemptNumber`.

`snapshot()` produces a `ContextSnapshot` — a plain, serializable subset that Resili attaches to its
own errors as `error.context`, which is how a `TimeoutError` can tell you which attempt and which
request it came from.

## Reading metadata

`metadata` is a `ReadonlyMap`, so it supports `get`, `has`, `size`, `forEach`, and iteration. The
mutating methods are not available, and attempting to mutate the map throws.

```ts
await client.execute((ctx) => {
  const tenant = ctx.metadata.get("tenantId");
  return fetchFor(String(tenant), { signal: ctx.signal });
});
```

Metadata is also how the default classifier learns that an operation is safe to retry after a network
error: it looks for `ctx.metadata.get("idempotent") === true`. See
[Error classification](../architecture/error-classification.md).

## Forking

Policies never mutate a context. They derive a child with `fork()`.

```ts
interface ContextForkPatch {
  readonly attemptNumber?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

What a fork does:

| Field                                                                | Behavior                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `requestId`, `operationName`, `serviceName`, `deadline`, `startedAt` | Inherited unchanged                                              |
| `attemptNumber`                                                      | Taken from the patch, otherwise the parent's value **plus one**  |
| `signal`                                                             | Recomposed — parent signal, patch signal, and deadline           |
| `metadata`                                                           | Reused as-is with no patch; otherwise merged, patch keys winning |

Retry forks with `{ attemptNumber }`. Timeout forks with its own controller's signal and the _same_
`attemptNumber`, since a timeout is not a new attempt. Hedge forks one context per attempt.

Because `attemptNumber` defaults to _parent + 1_, always pass it explicitly when forking for a reason
other than a new attempt.

## Metadata values are shared across forks

This is a contract worth stating plainly, because streaming depends on it.

**Metadata keys are copied shallowly; metadata values are never cloned.** With no metadata patch, the
child receives the _same map instance_. With a patch, the child gets a new map — but the values inside
it are the same object references.

The consequence: a mutable object placed in metadata on the root context is observable, and mutable,
from every descendant context — across retry forks and timeout forks alike, and in both directions.

```ts
const state = { seen: 0 };
const client = createClient(operation, { retry: { maxAttempts: 3 } });

await client.execute(
  (ctx) => {
    // Same object on every attempt, and visible to the caller afterwards.
    (ctx.metadata.get("state") as typeof state).seen += 1;
    return doWork(ctx.signal);
  },
  { metadata: { state } },
);

state.seen; // reflects every attempt
```

`@resili/llm` relies on exactly this behavior to track whether a stream has been committed: the
commit flag lives in metadata, so the retry classifier — running on an outer context — can observe a
commit that happened on an inner attempt context. See [LLM streaming](../llm/streaming.md).

Two practical implications:

- **Use it deliberately** for per-request accumulators that must survive retries.
- **Do not assume isolation.** Placing mutable state in metadata and expecting each attempt to get a
  fresh copy will not work. Put immutable values in metadata if you want fork isolation.

## Signals and forking

Fork composition is cumulative and one-directional: the child aborts when the parent aborts, when the
patch signal aborts, or when the deadline passes. Aborting a child never aborts its parent.

That asymmetry is precisely what makes per-attempt timeouts work — the timeout aborts its own child so
the attempt stops, while the logical request survives and retry starts a new attempt. The first abort
reason wins; a deadline abort uses a `DOMException` named `AbortError`.

See [Cancellation](cancellation.md).

## Setting context values

Pass an init object as the second argument to `execute`:

```ts
await client.execute((ctx) => callDownstream(ctx), {
  operationName: "charge-card",
  serviceName: "payments",
  metadata: { tenantId: "acme", idempotent: true },
  signal: callerController.signal,
});
```

Note that `metadata` is a **per-execution** value, not a client config key. Passing `metadata` to
`createClient` throws a `ConfigurationError` — the client config surface is closed.

## Limitations

- Context does not propagate implicitly. There is no `AsyncLocalStorage` integration, so a function
  that needs the context must receive it as a parameter.
- Metadata is not typed per key; values are `unknown` and require a cast or a runtime check.
- Metadata values are shared, never cloned — see above.
- `deadline` defaults to infinity. There is no global default request deadline.
