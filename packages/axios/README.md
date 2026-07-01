# @resili/axios

> Minimal Axios-compatible adapter for Resili.

`@resili/axios` wraps an Axios-compatible request implementation with
`@resili/core` and returns a small callable client with familiar methods such as
`get()`, `post()`, `put()`, `patch()`, `delete()`, and `request()`.

This package does not depend on Axios directly. It uses structural TypeScript
types so you can provide any compatible implementation.

For the full framework overview, see the [repository README](../../README.md).

## Installation

```bash
pnpm add @resili/core @resili/axios
```

```bash
npm install @resili/core @resili/axios
```

```bash
yarn add @resili/core @resili/axios
```

Node.js 20 or newer is required.

## Quick Start

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "@resili/axios";

const axiosImplementation: AxiosImplementation = async <T, D>(config: AxiosRequestConfig<D>) => ({
  data: { ok: true } as T,
  status: 200,
  statusText: "OK",
  config,
});

const axios = createAxios({
  axios: axiosImplementation,
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await axios.get("/users");
```

`createAxios()` requires an injected Axios-compatible implementation. The package
currently does not import or bundle the real `axios` package.

## createAxios()

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "/axios";

const axiosImplementation: AxiosImplementation = async (config) => {
  return {
    data: undefined,
    status: 204,
    statusText: "No Content",
    config,
  };
};

const axios = createAxios({
  axios: axiosImplementation,
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
| `fallback`       | Return an alternate Axios response.         |
| `classifier`     | Override failure classification.            |
| `store`          | Override the state store service.           |
| `clock`          | Override timers and time source.            |
| `policies`       | Register custom policy factories.           |

The `axios` option is adapter-specific and is removed before configuration is
passed to `@resili/core`.

## GET Example

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "/axios";

const axiosImplementation: AxiosImplementation = async <T, D>(config: AxiosRequestConfig<D>) => ({
  data: { users: [] } as T,
  status: 200,
  statusText: "OK",
  config,
});

const axios = createAxios({ axios: axiosImplementation });

const response = await axios.get<{ users: string[] }>("/users", {
  headers: { accept: "application/json" },
});
```

The adapter shallow-copies config and sets `config.signal` to the Resili context
signal for the active execution.

## POST Example

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "/axios";

const axiosImplementation: AxiosImplementation = async <T, D>(config: AxiosRequestConfig<D>) => ({
  data: { id: "42" } as T,
  status: 201,
  statusText: "Created",
  config,
});

const axios = createAxios({ axios: axiosImplementation });

const response = await axios.post<{ id: string }, { name: string }>(
  "/users",
  { name: "Ada" },
  { headers: { "content-type": "application/json" } },
);
```

For `post()`, `put()`, and `patch()`, the adapter copies the supplied `data` into
the request config.

## Retry Example

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "/axios";

const axiosImplementation: AxiosImplementation = async <T, D>(config: AxiosRequestConfig<D>) => ({
  data: { ok: true } as T,
  status: 200,
  statusText: "OK",
  config,
});

const axios = createAxios({
  axios: axiosImplementation,
  retry: {
    maxAttempts: 3,
    backoff: "fixed",
    baseDelayMs: 100,
    jitter: "none",
  },
  timeout: { perAttemptMs: 1_000 },
});

const response = await axios.request({ method: "get", url: "/status" });
```

Retry behavior is delegated to `@resili/core`.

## Callable Client

The returned object is callable and also exposes named methods:

```ts
const direct = await axios({ method: "get", url: "/users" });
const viaRequest = await axios.request({ method: "get", url: "/users" });
const viaGet = await axios.get("/users");
```

Supported methods are `request`, `get`, `delete`, `post`, `put`, and `patch`.

## Current Limitations

- No real Axios runtime dependency is included.
- No interceptors.
- No request transforms.
- No response transforms.
- No `axios.create()`.
- No cancel token support.
- No HTTP status classification.
- No response body handling beyond returning the injected implementation result.
- No OpenTelemetry or metrics exporters.

The adapter is intentionally thin. Use `@resili/core` policies or custom policies
for behavior beyond request wrapping.

## Documentation

- [Repository README](../../README.md)
- [`@resili/core` README](../core/README.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- [API specification](../../docs/API_SPECIFICATION.md)

## License

MIT © Nitin Kaushal and contributors.
