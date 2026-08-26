# @resili/undici

> Minimal Undici-compatible request adapter for Resili.

`@resili/undici` wraps an Undici-compatible request function with `@resili/core`.
It returns a single resilient `request(options)` function that preserves the
structural request and response shape implemented by this package.

This package does not depend on Undici directly. Provide an implementation that
matches the exported `UndiciImplementation` type.

For the full framework overview, see the [repository README](../../README.md).

## Installation

Install from the `beta` dist-tag — `latest` still points at an early `0.1.0-alpha.1` build.

```bash
pnpm add @resili/core@beta @resili/undici@beta
```

```bash
npm install @resili/core@beta @resili/undici@beta
```

```bash
yarn add @resili/core@beta @resili/undici@beta
```

Node.js 20 or newer is required. The current release is `0.2.0-beta.1`; see
[versioning](../../docs/releases/versioning.md).

`undici` itself is **not** a dependency or peer dependency of this package. You inject
a `request` implementation, so you keep control of the version and its configuration.

## Quick Start

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => ({
  statusCode: 200,
  headers: {},
  body: `requested ${options.path}`,
});

const request = createUndici({
  request: requestImplementation,
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await request({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
});
```

## createUndici()

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => {
  return {
    statusCode: 204,
    headers: {},
    body: `ok:${options.path}`,
  };
};

const request = createUndici({
  request: requestImplementation,
  circuitBreaker: { minimumThroughput: 10 },
});
```

Supported core config fields:

| Field            | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `retry`          | Retry failed calls.                         |
| `timeout`        | Apply per-attempt timeout behavior.         |
| `circuitBreaker` | Stop calls while a dependency is unhealthy. |
| `bulkhead`       | Bound concurrency and queue depth.          |
| `rateLimiter`    | Limit request rate in memory.               |
| `fallback`       | Return an alternate Undici response.        |
| `classifier`     | Override failure classification.            |
| `store`          | Override the state store service.           |
| `clock`          | Override timers and time source.            |
| `policies`       | Register custom policy factories.           |

The `request` option is adapter-specific and is removed before configuration is
passed to `@resili/core`.

## Basic Request Example

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: options.path }),
});

const request = createUndici({ request: requestImplementation });

const response = await request({
  origin: "https://api.example.com",
  path: "/health",
  method: "GET",
});
```

The adapter reads `options.signal` and passes it to `client.execute`. Core composes
it with timeout and other policy signals. Each attempt shallow-copies options and
sets `signal` to the composed `ctx.signal`.

## Cancellation Example

```ts
import { createUndici } from "@resili/undici";

const send = createUndici({
  request: (options) => request(`${options.origin}${options.path}`, options),
  timeout: { perAttemptMs: 2_000 },
});

const controller = new AbortController();

const pending = send({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
  signal: controller.signal,
});

controller.abort();
```

The caller signal enters Resili's execution context. The injected request function
receives the composed context signal. AbortSignal is the only supported
cancellation mechanism.

## Retry Example

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => ({
  statusCode: 200,
  headers: {},
  body: `requested ${options.origin}${options.path}`,
});

const request = createUndici({
  request: requestImplementation,
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: "none",
  },
});

const response = await request({
  origin: "https://api.example.com",
  path: "/orders",
  method: "GET",
});
```

Retry behavior is delegated to `@resili/core`.

## Timeout Example

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => ({
  statusCode: 200,
  headers: {},
  body: options.signal?.aborted ? "aborted" : "ok",
});

const request = createUndici({
  request: requestImplementation,
  timeout: { perAttemptMs: 750 },
});
```

Timeout passes the Resili context signal into the injected request implementation.

## Fallback Example

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async () => {
  throw new Error("downstream unavailable");
};

const request = createUndici({
  request: requestImplementation,
  fallback: {
    handler() {
      return { statusCode: 200, headers: {}, body: "fallback" };
    },
  },
});

const response = await request({
  origin: "https://api.example.com",
  path: "/status",
});
```

Fallback handlers may return an `UndiciResponse` or a promise for one.

## Current Limitations

- No real Undici runtime dependency is included.
- No Agent support.
- No Pool support.
- No Dispatcher helpers.
- No MockAgent or ProxyAgent helpers.
- No WebSocket support.
- No streaming helpers.
- No HTTP status classification. A `statusCode` of 503 is a returned value unless
  you opt in with `retry.retryOn`.
- No response body handling beyond returning the injected implementation result.
  A body must be fully consumed or discarded before a retry, or the connection leaks.
- No OpenTelemetry or metrics exporters.
- Pass caller cancellation as `options.signal`. The copy sent to the injected
  request function receives the composed Resili `ctx.signal`.
- Retry behavior inside the injected implementation is **not** disabled. A
  `RetryAgent` will retry inside each Resili attempt, multiplying total requests.

The adapter is intentionally thin. Use `@resili/core` policies or custom policies
for behavior beyond request wrapping.

## Documentation

- [Documentation home](../../docs/README.md)
- [undici adapter guide](../../docs/http/undici.md) — options, status codes, bodies, examples
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
