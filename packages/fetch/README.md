# @resili/fetch

> Native `fetch` adapter for Resili.

`@resili/fetch` wraps a fetch-compatible function with `@resili/core`, returning
a function with the same call shape as native `fetch(input, init?)`.

Use this package when you want retry, timeout, circuit breaker, bulkhead, rate
limiting, fallback, or custom policies around fetch calls without changing the
rest of your code to a different HTTP client.

For the full framework overview, see the [repository README](../../README.md).

## Installation

Install from the `beta` dist-tag — `latest` still points at an early `0.1.0-alpha.1` build.

```bash
pnpm add @resili/core@beta @resili/fetch@beta
```

```bash
npm install @resili/core@beta @resili/fetch@beta
```

```bash
yarn add @resili/core@beta @resili/fetch@beta
```

Node.js 20 or newer is required. The current release is `0.2.0-beta.1`; see
[versioning](../../docs/releases/versioning.md).

By default, the adapter uses `globalThis.fetch`. You may also inject a
fetch-compatible implementation for tests.

## Quick Start

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await resilientFetch("https://api.example.com/users", {
  method: "GET",
});
```

The returned function is typed as:

```ts
(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

## createFetch()

```ts
import { createFetch, type FetchImplementation } from "@resili/fetch";

const fetchImplementation: FetchImplementation = async (input, init) => {
  return await fetch(input, init);
};

const resilientFetch = createFetch({
  fetch: fetchImplementation,
  timeout: { perAttemptMs: 2_000 },
});
```

`createFetch()` accepts the implemented `@resili/core` configuration fields:

| Field            | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `retry`          | Retry failed calls.                         |
| `timeout`        | Apply per-attempt timeout behavior.         |
| `circuitBreaker` | Stop calls while a dependency is unhealthy. |
| `bulkhead`       | Bound concurrency and queue depth.          |
| `rateLimiter`    | Limit request rate in memory.               |
| `fallback`       | Return an alternate `Response` on errors.   |
| `classifier`     | Override failure classification.            |
| `store`          | Override the state store service.           |
| `clock`          | Override timers and time source.            |
| `policies`       | Register custom policy factories.           |

The `fetch` option is adapter-specific and is removed before configuration is
passed to `@resili/core`.

## Retry Example

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: "none",
  },
});

const response = await resilientFetch("https://api.example.com/orders");
```

Retry behavior is provided by `@resili/core`. Deterministic `jitter: "none"` is
supported by the current retry policy.

## Timeout Example

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 750 },
});

const response = await resilientFetch("https://api.example.com/health");
```

The adapter reads `init.signal` and passes it to `client.execute` as
`ContextInit.signal`. Core composes that with timeout and other policy signals.
Each attempt shallow-copies `RequestInit` and sets `signal` to the composed
`ctx.signal` — not the original caller signal.

## Cancellation Example

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const controller = new AbortController();

const request = resilientFetch("https://api.example.com/users", {
  signal: controller.signal,
});

controller.abort();
```

The caller signal enters Resili's execution context and is composed with timeout
and other policy cancellation. Fetch receives the resulting context signal.
AbortSignal is the only supported cancellation mechanism.

## Fallback Example

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 500 },
  fallback: {
    handler() {
      return new Response("cached fallback", { status: 200 });
    },
  },
});

const response = await resilientFetch("https://api.example.com/status");
```

Fallback handlers may return a `Response` or a promise for one.

## Custom Policies

```ts
import { definePolicy } from "@resili/core";
import { createFetch } from "@resili/fetch";

const headerPolicy = definePolicy({
  name: "headers-observer",
  order: { before: "timeout" },
  create() {
    return {
      name: "headers-observer",
      order: { before: "timeout" },
      execute(ctx, next) {
        console.log(ctx.requestId);
        return next(ctx);
      },
    };
  },
});

const resilientFetch = createFetch({
  policies: [{ factory: headerPolicy }],
});
```

## Testing With an Injected Fetch

```ts
import { createFetch, type FetchImplementation } from "@resili/fetch";

const fakeFetch: FetchImplementation = async () => {
  return new Response("ok", { status: 200 });
};

const resilientFetch = createFetch({ fetch: fakeFetch });
const response = await resilientFetch("https://example.test");
```

Injected fetch implementations are useful for deterministic tests and for custom
runtime environments.

## Current Limitations

- The adapter does not classify HTTP status codes.
- The adapter does not transform response bodies.
- The adapter does not retry based on `Response.status` by itself.
- The adapter does not add headers. It shallow-copies `RequestInit` rather than
  mutating yours. Pass caller cancellation as `init.signal`; the copy sent to
  fetch receives the composed Resili `ctx.signal`.
- A one-shot request body (a stream) cannot be replayed on retry.
- The adapter does not disable retry behavior inside an injected implementation.
- The adapter does not provide OpenTelemetry or metrics exporters.
- The adapter is intentionally a thin wrapper over `@resili/core`.

If you need status-code classification, provide a core classifier or `retry.retryOn`
predicate that matches your application contract.

## Documentation

- [Documentation home](../../docs/README.md)
- [fetch adapter guide](../../docs/http/fetch.md) — options, status codes, signals, examples
- [HTTP adapters overview](../../docs/http/overview.md) — what all three adapters share
- [Cancellation](../../docs/core/cancellation.md) · [All policies](../../docs/core/policies.md)
- [`@resili/core` README](../core/README.md)
- Specifications: [Architecture](../../docs/ARCHITECTURE.md),
  [API specification](../../docs/API_SPECIFICATION.md)

## Maintainer

Created and maintained by **Nitin Kaushal**.

- GitHub: https://github.com/nkcodedev
- Email: nkcodedev.chd@gmail.com

If you find the project useful, please consider starring the repository.

## License

MIT © Nitin Kaushal and contributors.
