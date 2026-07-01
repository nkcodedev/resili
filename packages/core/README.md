# @resili/core

> Core TypeScript resilience primitives for wrapping unreliable async work.

`@resili/core` is the foundation package for Resili. It provides the fluent builder,
`createClient()` factory, built-in resilience policies, plugin contracts/runtime,
context propagation, typed events, classification, metrics contracts, state contracts,
and framework errors.

For the full project overview, see the [repository README](../../README.md).

## Installation

```bash
pnpm add @resili/core
```

```bash
npm install @resili/core
```

```bash
yarn add @resili/core
```

Resili targets Node.js 20 or newer and ships TypeScript declarations.

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
    failureRateThreshold: 0.5,
    resetTimeoutMs: 30_000,
  },
});

const response = await client.call("https://api.example.com/users");
```

Supported config fields are:

| Field            | Purpose                                       |
| ---------------- | --------------------------------------------- |
| `retry`          | Retry failed downstream calls.                |
| `timeout`        | Apply per-attempt timeout behavior.           |
| `circuitBreaker` | Stop calls while a dependency is unhealthy.   |
| `bulkhead`       | Bound concurrency and queue depth.            |
| `rateLimiter`    | Limit request rate in memory.                 |
| `fallback`       | Return an alternate value on selected errors. |
| `classifier`     | Override failure classification.              |
| `store`          | Override the state store service.             |
| `clock`          | Override timers and time source.              |
| `policies`       | Register custom policy factories.             |

Unsupported config fields throw `ConfigurationError` at runtime.

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
  failureRateThreshold: 0.5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 2,
})
```

Circuit breaker state is stored in memory per client instance.

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
  onLimit: "reject",
})
```

Current behavior supports in-memory token bucket and sliding-window strategies
with reject mode.

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

- Built-in policy state is in-memory unless a policy explicitly supports another store.
- No OpenTelemetry or Prometheus exporters are included in core.
- HTTP status classification is not performed by adapter packages.
- Package versions are currently development placeholders.

## Documentation

- [Repository README](../../README.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- [API specification](../../docs/API_SPECIFICATION.md)
- [Internal design](../../docs/INTERNAL_DESIGN.md)

## License

MIT © Resili contributors.
