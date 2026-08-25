# @resili/core example

Retry, timeout, circuit breaker, fallback, and caller cancellation around a plain async function.

**No credentials and no network access required.** The "dependency" is a local function that fails
its first two calls, so the retry behavior is deterministic.

This directory is not a workspace package and is not executed in CI.

## Run it

From a clone of Resili, after `pnpm build`:

```bash
cd examples/core
pnpm add @resili/core@file:../../packages/core
node example.mjs
```

## What it shows

1. **Declarative configuration** with `createClient`, plus `client.on(...)` subscriptions for
   `RetryStarted` and `RequestCompleted`.
2. **The fluent builder** with a `fallback` handler, unwrapping `RetryExceededError.lastError` to find
   the real cause.
3. **Caller cancellation** through `client.execute(operation, { signal })`, where the operation reads
   `ctx.signal`.

Note that `circuitBreaker.failureRateThreshold` is a **percentage**: `50` means half the calls in the
window, not half a percent.

## Documentation

- [Core overview](../../docs/core/overview.md) · [All policies](../../docs/core/policies.md)
- [Policy ordering](../../docs/core/policy-ordering.md) · [Cancellation](../../docs/core/cancellation.md)
- [Configuration reference](../../docs/reference/configuration.md)
