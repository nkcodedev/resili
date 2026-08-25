# Fallback

Returns an alternate value instead of throwing.

**Pipeline position:** order `100` — the outermost policy, wrapping everything else.

## When to use it

When a degraded answer is better than an error: a cached price, an empty list, a default
configuration, a queued write. Fallback is the boundary where a resilience failure becomes a product
decision.

Because it is outermost, it sees the _final_ error after retry has given up, the breaker has
rejected, or the timeout has fired — one place to make one decision.

## Configuration

```ts
interface FallbackOptions<R> {
  readonly handler: (error: unknown, ctx: Context) => R | Promise<R>;
  readonly fallbackOn?: (error: unknown, ctx: Context) => boolean;
}

type FallbackFn<R> = (error: unknown, ctx: Context) => R | Promise<R>;
```

A bare function is accepted as shorthand for `{ handler }`:

```ts
createClient(operation, { fallback: () => cachedValue });
createClient(operation, { fallback: { handler: () => cachedValue } });
```

| Option       | Default  | Notes                                            |
| ------------ | -------- | ------------------------------------------------ |
| `handler`    | required | Receives the original error and the context.     |
| `fallbackOn` | —        | Predicate deciding whether to handle this error. |

## Behavior

```text
try {
  return await next(ctx);
} catch (error) {
  if (fallbackOn?.(error, ctx) === false) throw error;
  return await handler(error, ctx);
}
```

Three things follow from that shape, and they surprise people:

1. **Success is untouched.** Fallback only ever sees a rejection.
2. **Every error is handled by default.** With no `fallbackOn`, _all_ failures route to the handler —
   including `ConfigurationError` and programming mistakes like `TypeError`. Supply `fallbackOn` if
   you want to be selective.
3. **`fallbackOn` must return exactly `false` to decline.** Any other value, including `undefined`
   from a predicate that forgot to return, is treated as "handle it".

The handler receives the original error, unwrapped as thrown by the policy beneath it — commonly
`RetryExceededError`, `TimeoutError`, `CircuitOpenError`, `RateLimitExceededError`, or
`BulkheadRejectedError`. If the handler itself throws, that error propagates to the caller.

## Errors

Fallback raises no errors of its own beyond `ConfigurationError` for invalid options. It either
rethrows the original error or returns the handler's result.

## AbortSignal

The fallback policy does not read `ctx.signal`. Note the consequence: a caller cancellation surfaces
as an `AbortError`, which — absent a `fallbackOn` guard — is handled like any other error, so a
cancelled call can return a fallback value instead of rejecting. If that is not what you want,
exclude it explicitly.

```ts
import { AbortError } from "@resili/core";

fallback: {
  fallbackOn: (error) => !(error instanceof AbortError),
  handler: () => degradedResponse(),
}
```

## Interaction with other policies

- Fallback is outermost, so its handler runs **after** retry has exhausted its attempts — not per
  attempt. Use `retryOn` if you need per-attempt logic.
- **Cache** is directly inside fallback, which means a fallback value can be written to the cache.
- With **dedupe**, the shared execution runs once but each caller runs its own fallback handler.
- The fallback result is neither retried nor cached by the fallback policy itself.

## Events

Fallback emits no events and records no metrics. To observe how often it fires, instrument the
handler or watch `RequestCompleted`.

## Example

```ts
import { CircuitOpenError, createClient, RetryExceededError, TimeoutError } from "@resili/core";

const pricing = createClient(fetchLivePrice, {
  timeout: { perAttemptMs: 500 },
  retry: { maxAttempts: 3, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  fallback: {
    fallbackOn: (error) =>
      error instanceof RetryExceededError ||
      error instanceof TimeoutError ||
      error instanceof CircuitOpenError,
    async handler(error, ctx) {
      metrics.increment("pricing.degraded");
      return await lastKnownPrice(ctx.requestId);
    },
  },
});
```

## Limitations

- Handles all errors unless you narrow it, which can mask bugs.
- Only errors trigger it. There is no "fallback on an unacceptable success value" — use
  [hedge](hedge.md)'s `shouldAccept`, or throw from your operation.
- Single handler; there is no chain of successive fallbacks.
- No built-in observability.
