# `@resili/core` overview

`@resili/core` is the runtime: context, the policy pipeline, the built-in policies, the event bus,
the metrics contract, the error hierarchy, and the plugin system. It has **zero runtime
dependencies** and knows nothing about HTTP or LLMs.

Current version: **`0.2.0-alpha.3`**.

## Two entry points

Both produce the same kind of client and accept the same policy options.

```ts
import { createClient, resili } from "@resili/core";

// Declarative
const a = createClient(operation, { retry: { maxAttempts: 3 }, timeout: 1_000 });

// Fluent
const b = resili(operation).retry({ maxAttempts: 3 }).timeout(1_000).build();
```

## Client config

`createClient(operation, config)` accepts exactly these top-level keys. Anything else throws a
`ConfigurationError` with the offending `field` — the config surface is intentionally closed so typos
fail loudly.

| Key              | Type                            | Docs                                                            |
| ---------------- | ------------------------------- | --------------------------------------------------------------- |
| `retry`          | `RetryOptions`                  | [Retry](retry.md)                                               |
| `timeout`        | `number \| TimeoutOptions`      | [Timeout](timeout.md)                                           |
| `circuitBreaker` | `CircuitBreakerOptions`         | [Circuit breaker](circuit-breaker.md)                           |
| `rateLimiter`    | `RateLimiterOptions`            | [Rate limiter](rate-limiter.md)                                 |
| `bulkhead`       | `number \| BulkheadOptions`     | [Bulkhead](bulkhead.md)                                         |
| `cache`          | `CacheOptions`                  | [Cache](cache.md)                                               |
| `fallback`       | `FallbackOptions \| FallbackFn` | [Fallback](fallback.md)                                         |
| `dedupe`         | `DedupeOptions`                 | [Dedupe](dedupe.md)                                             |
| `hedge`          | `HedgeOptions`                  | [Hedge](hedge.md)                                               |
| `classifier`     | `FailureClassifier`             | [Error classification](../architecture/error-classification.md) |
| `store`          | `StateStore`                    | Pluggable policy state backing                                  |
| `clock`          | `Clock`                         | Injectable time source (see below)                              |
| `metrics`        | `MetricsRecorder`               | Policy metrics; default `noopMetrics`. Also `withMetrics`       |
| `policies`       | `{ factory, options? }[]`       | [Custom policies](policy-ordering.md#custom-policies)           |

Note there is no `metadata` or `events` config key. Subscribe to events with `client.on(...)` after
construction.

## The Clock

Every policy that measures time — retry delays, timeout timers, circuit breaker windows, rate
limiter refills, cache TTLs — goes through an injectable `Clock` rather than calling `Date.now()` or
`setTimeout` directly.

```ts
interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}
```

This is what makes policy behavior deterministic in tests: supply a fake clock and advance it
manually instead of sleeping.

## Custom policies and plugins

`definePolicy` creates a policy; `definePlugin` bundles policy registration, event subscriptions,
and service overrides behind one install step.

```ts
import { definePolicy, resili } from "@resili/core";

const logging = definePolicy({
  name: "logging",
  order: { before: "timeout" },
  create() {
    return {
      name: "logging",
      order: { before: "timeout" },
      async execute(ctx, next) {
        console.log("start", ctx.requestId, "attempt", ctx.attemptNumber);
        return await next(ctx);
      },
    };
  },
});

const client = resili(operation).policy(logging).build();
```

Plugins are installed with `.use(plugin, options?)`; they support dependency validation, priority
ordering of _setup_, and reverse-order disposal on `client.destroy()`. Setup priority does not change
runtime policy order — that is always governed by each policy's `order`.

## What core does not do

- No HTTP awareness. It never reads a `Response`, a status code, or a header on its own; the default
  classifier can interpret an outcome you hand it, but core does not perform requests.
- No distributed state. Circuit breaker, cache, rate limiter, bulkhead, and dedupe state is
  in-memory and per client instance.
- No metrics for every policy. Only cache, dedupe, and hedge record metrics today. See
  [Metrics](../observability/metrics.md).

## Continue

- [Policies at a glance](policies.md)
- [Policy ordering](policy-ordering.md)
- [Execution context](execution-context.md)
- [Cancellation](cancellation.md)
