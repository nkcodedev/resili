# `@resili/axios`

An axios-shaped API backed by a Resili pipeline.

```text
Application → createAxios(...) → @resili/core → your axios implementation
```

Current version: **`0.2.0-alpha.3`**. Depends only on `@resili/core`.

## Installation

```bash
npm install @resili/core@alpha @resili/axios@alpha
```

The package does **not** import `axios` and does not declare it as a peer dependency. It describes the
axios call shape structurally, so you inject the implementation you already own. Install `axios`
because _your_ code uses it, not because the adapter needs it.

## Creating a client

```ts
import axios from "axios";
import { createAxios } from "@resili/axios";

const api = createAxios({
  axios: (config) => axios.request(config),
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await api.get("https://api.example.com/users");
console.log(response.status, response.data);
```

`axios` is **required** — there is no default implementation. Injecting an instance rather than the
global default is the usual choice, and it lets you keep your own base URL, headers, and interceptors:

```ts
const instance = axios.create({
  baseURL: "https://api.example.com",
  headers: { authorization: `Bearer ${token}` },
});

const api = createAxios({
  axios: (config) => instance.request(config),
  retry: { maxAttempts: 2, jitter: "none" },
});
```

### Options

```ts
interface CreateAxiosOptions extends ResiliConfig<AxiosResponse> {
  readonly axios: AxiosImplementation;
}

type AxiosImplementation = <T = unknown, D = unknown>(
  config: AxiosRequestConfig<D>,
) => Promise<AxiosResponse<T, D>>;
```

`axios` is the only adapter-specific key; everything else is standard
[`ResiliConfig`](../core/overview.md#client-config).

## The returned client

Unlike the other two adapters, this one returns an object with verb helpers as well as being callable.
The object is frozen.

```ts
interface ResilientAxios {
  <T, D>(config: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  request<T, D>(config: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  get<T, D>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  delete<T, D>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  post<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  put<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  patch<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
}
```

```ts
await api({ url: "/users", method: "get" });
await api.request({ url: "/users", method: "get" });
await api.get("/users");
await api.post("/users", { name: "Ada" });
await api.patch("/users/1", { name: "Ada L." });
await api.delete("/users/1");
```

`post`, `put`, and `patch` add `data` to the config only when it is not `undefined`.

The structural `AxiosRequestConfig` and `AxiosResponse` types carry an index signature, so any extra
axios field you set is passed through to the implementation untouched — but only the fields listed in
the interfaces are typed.

## Policies

```ts
const api = createAxios({
  axios: (config) => instance.request(config),
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  rateLimiter: { limit: 50, intervalMs: 1_000 },
  bulkhead: { maxConcurrent: 20 },
  fallback: (error) => {
    if (isRecoverable(error)) {
      return { data: [], status: 200, statusText: "OK", config: {} };
    }
    throw error;
  },
});
```

## Status codes

axios itself throws on non-2xx by default via `validateStatus`, which means whether Resili sees a
failure depends on the implementation **you** injected.

- If you inject `axios.request` with default settings, a 500 rejects, and Resili's retry and circuit
  breaker see a failure — a generic `Error`, so it is a _failure but not retryable_ under the default
  classifier. Add `retryOn` to retry it.
- If your instance sets `validateStatus: () => true`, a 500 resolves and Resili sees success. Classify
  it yourself:

```ts
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

retry: {
  maxAttempts: 3,
  jitter: "none",
  retryOn: (outcome) =>
    outcome.status === "error" ||
    (outcome.status === "success" && RETRYABLE.has(outcome.value.status)),
}
```

The adapter itself never inspects a status.

## AbortSignal propagation

Per attempt, the adapter shallow-copies your config and sets `signal` to `ctx.signal`:

```ts
axiosImplementation({ ...config, signal: ctx.signal });
```

A `signal` you place on the config is **replaced, not merged**; your config object is not mutated.
Note also that Resili uses `signal`, the modern axios cancellation mechanism — legacy `CancelToken` is
not supported.

## Errors

No adapter-specific error types. Errors from your implementation — including `AxiosError` — propagate
unchanged as the same instance, so `error.response`, `error.code`, and `isAxiosError` all still work.

Layered on top are the usual Resili errors: `TimeoutError`, `RetryExceededError` (with the
`AxiosError` on `lastError`), `CircuitOpenError`, `RateLimitExceededError`, `BulkheadRejectedError`,
and `AbortError`.

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";
import { isAxiosError } from "axios";

try {
  await api.get("/users");
} catch (error) {
  if (error instanceof RetryExceededError && isAxiosError(error.lastError)) {
    console.error(error.lastError.response?.status);
  } else if (error instanceof TimeoutError) {
    console.error(`timed out after ${error.timeoutMs}ms`);
  }
}
```

## Differences from calling axios directly

| Behavior              | axios                              | `createAxios(...)`                                       |
| --------------------- | ---------------------------------- | -------------------------------------------------------- |
| API surface           | Full                               | Callable + `request`/`get`/`delete`/`post`/`put`/`patch` |
| Interceptors          | Yes                                | **Not implemented** — configure on your instance         |
| Transforms            | Yes                                | **Not implemented**                                      |
| `axios.create()`      | Yes                                | **Not implemented** — inject a created instance          |
| `CancelToken`         | Supported (deprecated)             | **Not supported**; `signal` only                         |
| `config.signal`       | Honored                            | **Replaced** by the context signal                       |
| Status handling       | `validateStatus` throws on non-2xx | Inherited from your implementation, not re-interpreted   |
| Its own retry plugins | e.g. `axios-retry`                 | **Not disabled** — see below                             |
| Return value          | `AxiosResponse`                    | The same `AxiosResponse`, unwrapped                      |

### Do not stack retries

The adapter does not disable anything in the instance you inject. An instance with `axios-retry`
installed will retry _inside_ each Resili attempt, so `maxAttempts: 3` on top of three axios retries is
nine requests with unpredictable timing.

Pick one owner for retry behavior. If you want Resili to own it — the recommendation, since retry then
composes with the circuit breaker, budget, and classifier — remove the axios-side retry plugin from
the instance you inject.

## Example

```ts
import axios from "axios";
import { createAxios } from "@resili/axios";

const instance = axios.create({
  baseURL: "https://api.example.com",
  validateStatus: () => true, // let Resili decide
});

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export const api = createAxios({
  axios: (config) => instance.request(config),
  timeout: { perAttemptMs: 2_000 },
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 200,
    jitter: "none",
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" && RETRYABLE.has(outcome.value.status)),
  },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
});

const { data } = await api.get<{ id: string }[]>("/users");
```

## Limitations

- No interceptors, transforms, cancel tokens, or `axios.create()`.
- `config.signal` is overwritten.
- Structural types only; not the real axios type definitions.
- Single-use request bodies are unsafe to retry — the same reference is reused per attempt.
- The injected implementation's own retry behavior is not disabled.
