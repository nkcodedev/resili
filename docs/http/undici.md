# `@resili/undici`

An undici-shaped `request` function backed by a Resili pipeline.

```text
Application → createUndici(...) → @resili/core → your undici request
```

Current version: **`0.2.0-beta.1`**. Depends only on `@resili/core`.

## Installation

```bash
npm install @resili/core @resili/undici
```

The package does **not** import `undici` and does not declare it as a peer dependency. It describes the
undici call shape structurally, so you inject the implementation and keep full control of the
dispatcher, pool, and connection settings.

## Creating a client

```ts
import { request } from "undici";
import { createUndici } from "@resili/undici";

const send = createUndici({
  request: (options) => request(`${options.origin}${options.path}`, options),
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await send({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
});

console.log(response.statusCode);
```

`request` is **required** — there is no default implementation.

### Options

```ts
interface CreateUndiciOptions extends ResiliConfig<UndiciResponse> {
  readonly request: UndiciImplementation;
}

type UndiciImplementation = (options: UndiciRequestOptions) => Promise<UndiciResponse>;

interface UndiciRequestOptions {
  readonly origin: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

interface UndiciResponse {
  readonly statusCode: number;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}
```

`origin` and `path` are required and separate — this is the one adapter that does not take a single
URL. Note that the response field is `statusCode`, not `status`.

Extra fields pass through to your implementation thanks to the index signature, so
`bodyTimeout`, `headersTimeout`, `dispatcher`, and friends work even though they are not typed.

### Using a pool or dispatcher

Configure connection behavior on the instance you inject:

```ts
import { Pool } from "undici";
import { createUndici } from "@resili/undici";

const pool = new Pool("https://api.example.com", { connections: 32 });

const send = createUndici({
  request: (options) =>
    pool.request({ path: options.path, method: options.method ?? "GET", ...options }),
  bulkhead: { maxConcurrent: 32 }, // match the pool
  timeout: { perAttemptMs: 1_000 },
});
```

Aligning the bulkhead with the pool size is a good habit: it makes saturation surface as a fast
`BulkheadRejectedError` instead of an opaque queue inside undici.

## Policies

```ts
const send = createUndici({
  request: (options) => request(`${options.origin}${options.path}`, options),
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  rateLimiter: { limit: 200, intervalMs: 1_000 },
  bulkhead: { maxConcurrent: 32, maxQueue: 64, queueTimeoutMs: 250 },
});
```

## Status codes do not fail by default

`undici.request` resolves for every status, including 5xx. Resili therefore sees success, and the
response is neither retried nor recorded as a breaker failure unless you classify it:

```ts
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

retry: {
  maxAttempts: 3,
  jitter: "none",
  retryOn: (outcome) =>
    outcome.status === "error" ||
    (outcome.status === "success" && RETRYABLE.has(outcome.value.statusCode)),
}
```

Remember the field name is `statusCode`.

There is a subtlety specific to undici: retrying on status means the previous response's body is
**never consumed**. undici expects response bodies to be read or dumped, so discarding them can
tie up the connection. If you retry on status, dump the body you are abandoning:

```ts
retryOn: (outcome) => {
  if (outcome.status === "error") return true;
  if (outcome.status === "success" && RETRYABLE.has(outcome.value.statusCode)) {
    void (outcome.value.body as { dump?: () => Promise<void> })?.dump?.();
    return true;
  }
  return false;
},
```

## AbortSignal propagation

Per attempt, the adapter shallow-copies your options and sets `signal` to `ctx.signal`:

```ts
requestImplementation({ ...requestOptions, signal: ctx.signal });
```

The adapter reads `options.signal` and passes it to `client.execute`. Each attempt
shallow-copies your options and sets `signal` to composed `ctx.signal`. Your options
object is not mutated.

Because undici honors `signal`, a per-attempt timeout closes the socket rather than merely abandoning
the promise.

## Errors

No adapter-specific error types. Errors from your implementation propagate unchanged, including
undici's own — `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`,
`UND_ERR_SOCKET`.

Layered on top: `TimeoutError`, `RetryExceededError` (with the undici error on `lastError`),
`CircuitOpenError`, `RateLimitExceededError`, `BulkheadRejectedError`, and `AbortError`.

Under the default classifier an undici error is a generic `Error` — a **failure but not retryable**.
Use `retryOn` to opt in:

```ts
const RETRYABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
]);

retryOn: (outcome) =>
  outcome.status === "error" &&
  RETRYABLE_CODES.has((outcome.error as { code?: string })?.code ?? ""),
```

## Differences from calling undici directly

| Behavior                             | `undici.request`                | `createUndici(...)`                                          |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| Call shape                           | `(url, options)`                | `(options)` with required `origin` + `path`                  |
| Return value                         | Response object                 | The same object, unwrapped                                   |
| Status handling                      | Resolves on all statuses        | Same — no automatic classification                           |
| `options.signal`                     | Honored                         | Composed into Resili; transport gets `ctx.signal`            |
| `Agent`/`Pool`/`Dispatcher`          | Yes                             | **Not implemented** — configure on your instance             |
| `MockAgent`, `ProxyAgent`, WebSocket | Yes                             | **Not implemented**                                          |
| Body helpers (`.json()`, `.text()`)  | Yes                             | Untouched on the returned object; the adapter never reads it |
| undici's own retry (`RetryAgent`)    | Yes                             | **Not disabled** — see below                                 |
| Timeouts                             | `bodyTimeout`, `headersTimeout` | Additionally `timeout.perAttemptMs` per attempt              |

### Do not stack retries

The adapter does not disable anything in the implementation you inject. A `RetryAgent`, or a
dispatcher configured with retries, will retry _inside_ each Resili attempt and multiply with
Resili's own.

Pick one owner. If you want Resili to own retry behavior — the recommendation, so it composes with the
circuit breaker and classifier — do not wrap your dispatcher in a `RetryAgent`.

Undici's `bodyTimeout` and `headersTimeout` are complementary rather than conflicting: they bound
phases of a single request, while `perAttemptMs` bounds the attempt as a whole. Keep `perAttemptMs`
greater than the sum of the phase timeouts so the more specific error surfaces first.

## Example

```ts
import { Pool } from "undici";
import { createUndici } from "@resili/undici";

const pool = new Pool("https://api.example.com", { connections: 32 });
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export const send = createUndici({
  request: (options) =>
    pool.request({
      path: options.path,
      method: (options.method ?? "GET") as "GET",
      headers: options.headers as Record<string, string>,
      body: options.body as string | undefined,
      signal: options.signal,
    }),
  timeout: { perAttemptMs: 2_000 },
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 100,
    jitter: "none",
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" && RETRYABLE.has(outcome.value.statusCode)),
  },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  bulkhead: { maxConcurrent: 32, maxQueue: 64, queueTimeoutMs: 250 },
});

const response = await send({ origin: "https://api.example.com", path: "/users", method: "GET" });
const users = await (response.body as { json(): Promise<unknown> }).json();
```

## Limitations

- No `Agent`, `Pool`, `Dispatcher`, `MockAgent`, `ProxyAgent`, WebSocket, or streaming helpers.
- No body handling — the adapter never reads, clones, or dumps a response body.
- Pass caller cancellation as `options.signal`; the transport receives composed `ctx.signal`.
- `origin` and `path` are required and must be supplied separately.
- Structural types only; not the real undici type definitions.
- The injected implementation's own retry behavior is not disabled.
