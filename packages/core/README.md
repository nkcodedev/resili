# @resili/core

> Core TypeScript resilience primitives for wrapping unreliable async work.

`@resili/core` is the foundation package for Resili. It provides the fluent builder,
`createClient()` factory, built-in resilience policies, plugin contracts/runtime,
context propagation, typed events, classification, metrics contracts, state contracts,
and framework errors.

For the full project overview, see the [repository README](../../README.md).

## Installation

Install from the `alpha` dist-tag — `latest` still points at an early `0.1.0-alpha.1` build.

```bash
pnpm add @resili/core@alpha
```

```bash
npm install @resili/core@alpha
```

```bash
yarn add @resili/core@alpha
```

Resili targets Node.js 20 or newer and ships ESM, CommonJS, and TypeScript declarations. The current
release is `0.2.0-alpha.3`; see [versioning](../../docs/releases/versioning.md).

## Quick Start

```ts
import { resili } from "@resili/core";

const getUser = resili(async (id: string) => {
  const response = await fetch(`https://api.example.com/users/${id}`);
  return response.json() as Promise<{ id: string; name: string }>;
})
  .timeout({ perAttemptMs: 1_000 })
  .retry({ maxAttempts: 3, backoff: "exponential", jitter: "none" })
  .circuitBreaker({ minimumThroughput: 10 })
  .build();

const user = await getUser.call("42");
```

The returned client preserves the wrapped operation signature. If your operation
accepts `(id: string)`, `client.call()` accepts the same arguments.

## Purpose

Use `@resili/core` when you want to compose resilience behavior around any async
operation:

- HTTP calls through native `fetch` or adapter packages.
- SDK calls to third-party services.
- Database or cache calls.
- Queue producers and consumers.
- Internal async workflows that need bounded failure behavior.

Core is intentionally transport-agnostic. HTTP adapters live in separate packages.

## Builder API

The fluent builder is the primary API for operation-local configuration.

```ts
import { resili } from "@resili/core";

const client = resili((url: string) => fetch(url))
  .retry({ maxAttempts: 3, jitter: "none" })
  .timeout(1_000)
  .bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  .rateLimiter({ limit: 100, intervalMs: 1_000 })
  .fallback({
    handler() {
      return new Response("fallback", { status: 200 });
    },
  })
  .build();

const response = await client.call("https://api.example.com/health");
```

Builder instances are immutable and chainable. Each method returns a new builder
configuration without mutating the previous one.

## createClient()

Use `createClient()` when configuration is easier to express as data.

```ts
import { createClient } from "@resili/core";

const client = createClient((url: string) => fetch(url), {
  timeout: { perAttemptMs: 1_000 },
  retry: {
    maxAttempts: 3,
    backoff: "fixed",
    baseDelayMs: 100,
    jitter: "none",
  },
  circuitBreaker: {
    minimumThroughput: 10,
    failureRateThreshold: 50,
    resetTimeoutMs: 30_000,
  },
});

const response = await client.call("https://api.example.com/users");
```

`failureRateThreshold` is a **percentage**: `50` means half the calls in the window.

Supported config fields are:

| Field            | Purpose                                       |
| ---------------- | --------------------------------------------- |
| `retry`          | Retry failed downstream calls.                |
| `timeout`        | Apply per-attempt timeout behavior.           |
| `circuitBreaker` | Stop calls while a dependency is unhealthy.   |
| `rateLimiter`    | Limit request rate in memory.                 |
| `bulkhead`       | Bound concurrency and queue depth.            |
| `cache`          | Reuse successful results for a TTL.           |
| `fallback`       | Return an alternate value on selected errors. |
| `dedupe`         | Share concurrent same-key in-flight work.     |
| `hedge`          | Start a delayed duplicate attempt.            |
| `classifier`     | Override failure classification.              |
| `store`          | Override the state store service.             |
| `clock`          | Override timers and time source.              |
| `policies`       | Register custom policy factories.             |

Unsupported config fields throw `ConfigurationError` when the client is built, not at request time.
See the [configuration reference](../../docs/reference/configuration.md) for every option and default.

## Built-in Policies

### Retry

```ts
.retry({
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitter: "none",
})
```

Supports fixed and exponential backoff, retry predicates, total delay budgets,
and retry-after classification support. Deterministic `jitter: "none"` is
implemented.

### Timeout

```ts
.timeout({ perAttemptMs: 1_000 })
// or
.timeout(1_000)
```

Timeout forks the execution context and passes an abort signal to downstream
work through `Context`.

### Circuit Breaker

```ts
.circuitBreaker({
  minimumThroughput: 10,
  failureRateThreshold: 50,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 2,
})
```

Thresholds are percentages. Circuit breaker state is stored in memory per client instance.

### Bulkhead

```ts
.bulkhead({
  maxConcurrent: 25,
  maxQueue: 100,
  queueTimeoutMs: 500,
})
```

Bulkhead isolates concurrency by key and preserves FIFO queue ordering.

### Rate Limiter

```ts
.rateLimiter({
  strategy: "token-bucket",
  limit: 100,
  intervalMs: 1_000,
  burst: 200,
  onLimit: "wait",
  maxWaitMs: 500,
})
```

In-memory token bucket and sliding-window strategies support `onLimit: "reject"`
(immediate `RateLimitExceededError`) and `onLimit: "wait"`. Wait mode sleeps
until a token is available, up to `maxWaitMs`, then rejects immediately if the
next wait would exceed the remaining budget. Waiters for the same key are
admitted FIFO. `maxWaitMs` is required for wait mode and is rejected in reject
mode. `RateLimited` is emitted when a request first cannot be admitted
(`waited: false`) and again if a wait started but `maxWaitMs` is then exceeded
(`waited: true`).

`RequestStarted` and `RequestCompleted` are emitted once per top-level
`call()` / `execute()`. Retries do not emit additional lifecycle pairs.
`RequestCompleted.status` is `"success"` or `"error"`; `errorCode` is set only
for Resili errors. Fallback success completes as `"success"`.

`client.stats().totals` tracks calls, successes, failures, and retries (extra
attempts after the first). The snapshot does not include circuit, bulkhead, or
rate-limiter maps. `health().status` is always `"healthy"` because those maps
are not published; do not use it as a dependency readiness probe.

### Fallback

```ts
.fallback({
  fallbackOn(error) {
    return error instanceof Error;
  },
  handler() {
    return new Response("temporary fallback", { status: 200 });
  },
})
```

Fallback handlers may be synchronous or asynchronous.

### Cache

```ts
.cache({
  key: (id: string) => id,
  ttl: 5_000,
})
```

Stores successful values in a per-client in-memory cache. Entries expire lazily by TTL and are evicted
with bounded FIFO behavior (`maxEntries`, default `1000`). Failures are never cached. Being near the
outside of the pipeline, a hit bypasses retry, timeout, admission control, and the operation itself.

### Request Deduplication

```ts
.dedupe({
  key: (id: string) => id,
})
```

Shares concurrent same-key in-flight executions so only one reaches the operation. It does not cache
completed results — compose it with `cache` for that.

### Hedged Requests

```ts
.hedge({
  delay: 100,
})
```

Starts the original execution immediately and, if no acceptable result arrives within `delay`, starts
one duplicate. `maxAttempts` must be `2`. Use it only for safe or idempotent operations, since it
increases downstream load.

## Plugin Support

Plugins can register policies, subscribe to events, override services, and return
instances that are disposed when the client is destroyed.

```ts
import { definePlugin, definePolicy, resili, type Context } from "@resili/core";

const auditPlugin = definePlugin({
  name: "audit",
  version: "1.0.0",
  apiVersion: "1.0.0",
  setup(ctx) {
    ctx.on("RequestCompleted", (event) => {
      console.log(event.operationName, event.status);
    });

    ctx.registerPolicy(
      definePolicy({
        name: "audit-policy",
        order: { before: "timeout" },
        create() {
          return {
            name: "audit-policy",
            order: { before: "timeout" },
            execute(policyCtx: Context, next) {
              return next(policyCtx);
            },
          };
        },
      }),
    );

    return { name: "audit" };
  },
});

const client = resili((url: string) => fetch(url))
  .use(auditPlugin)
  .build();
```

Supported plugin runtime behavior includes dependency validation, duplicate name
validation, dependency ordering, priority ordering, setup execution, event
registration, policy registration, service overrides, plugin lookup, and reverse
install-order disposal.

## Architecture Summary

```text
Client.call(...args)
  ↓
Context creation
  ↓
Compiled policy pipeline
  ↓
Wrapped operation
  ↓
Context release
```

Core modules are deliberately small:

- **Client** owns operation execution, health, stats, and lifecycle.
- **Context** carries request metadata, attempt number, deadline, signal, and metadata.
- **Policy** wraps downstream work through middleware-style execution.
- **Pipeline** orders and executes policies deterministically.
- **Events** provide typed subscriptions.
- **Classification** decides whether outcomes are failures.
- **State, Clock, Metrics** are replaceable service contracts.

## Current Limitations

- Built-in policy state is in-memory and per-process. Breaker state, rate limits, bulkhead slots, and
  cache entries are not shared across instances. `StateStore` is the seam; no distributed
  implementation ships yet.
- `retry.jitter` is `"none"` only. Other values throw `ConfigurationError`.
- `retry.idempotentOnly` is not a public option; `true` still throws if passed at runtime.
- `timeout.deadlineMs` is rejected. Use `ContextInit.deadlineMs` / `deadline` for an overall bound.
  Timeouts remain per-attempt.
- `hedge.maxAttempts` must be `2`.
- Cache eviction is FIFO rather than LRU, and concurrent misses are not deduplicated.
- No OpenTelemetry or Prometheus exporters are included in core.
- HTTP status classification is not performed by adapter packages.

The full list is in [alpha status](../../docs/releases/alpha-status.md).

## Documentation

- [Documentation home](../../docs/README.md)
- [Core overview](../../docs/core/overview.md) — client entry points and configuration
- [All policies](../../docs/core/policies.md) — one page per policy
- [Policy ordering](../../docs/core/policy-ordering.md) — the default pipeline and why order matters
- [Execution context](../../docs/core/execution-context.md) · [Cancellation](../../docs/core/cancellation.md)
- [Configuration reference](../../docs/reference/configuration.md) · [Error reference](../../docs/reference/errors.md)
- [Events](../../docs/observability/events.md) · [Metrics](../../docs/observability/metrics.md)
- Specifications: [Architecture](../../docs/ARCHITECTURE.md),
  [API specification](../../docs/API_SPECIFICATION.md), [Internal design](../../docs/INTERNAL_DESIGN.md)

## Maintainer

Created and maintained by **Nitin Kaushal**.

- GitHub: https://github.com/nkcodedev
- Email: nkcodedev.chd@gmail.com

If you find the project useful, please consider starring the repository.

## License

MIT © Nitin Kaushal and contributors.
