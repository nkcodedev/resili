# `@resili/fetch`

A fetch-compatible function backed by a Resili pipeline.

```text
Application → createFetch(...) → @resili/core → fetch implementation
```

Current version: **`0.2.0-alpha.3`**. Depends only on `@resili/core`.

## Installation

```bash
npm install @resili/core@alpha @resili/fetch@alpha
```

No peer dependency: the adapter defaults to `globalThis.fetch`, available natively on Node.js 20+.

## Creating a client

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 100, jitter: "none" },
  circuitBreaker: { minimumThroughput: 10, failureRateThreshold: 50 },
});

const response = await resilientFetch("https://api.example.com/users");
const users = await response.json();
```

The returned function has the same signature as `fetch`:

```ts
type ResilientFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

Create it once at module scope and reuse it — policy state lives on the underlying client.

### Options

```ts
interface CreateFetchOptions extends ResiliConfig<Response> {
  readonly fetch?: FetchImplementation;
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

`fetch` is the only adapter-specific key; everything else is standard
[`ResiliConfig`](../core/overview.md#client-config). Injecting an implementation is useful for tests,
for a proxy-aware wrapper, or for `undici`'s fetch:

```ts
import { fetch as undiciFetch } from "undici";

const resilientFetch = createFetch({
  fetch: undiciFetch as unknown as FetchImplementation,
  retry: { maxAttempts: 2, jitter: "none" },
});
```

## Policies

Every core policy is available. The ones you will reach for most:

```ts
const resilientFetch = createFetch({
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  circuitBreaker: { failureRateThreshold: 50, minimumThroughput: 20, resetTimeoutMs: 10_000 },
  rateLimiter: { limit: 100, intervalMs: 1_000 },
  bulkhead: { maxConcurrent: 20, maxQueue: 50 },
  fallback: () => new Response(JSON.stringify({ degraded: true }), { status: 200 }),
});
```

Note the ordering consequence: `timeout` is per attempt, so with `maxAttempts: 3` the worst case is
roughly three seconds plus backoff, not two. See [Policy ordering](../core/policy-ordering.md).

## Status codes do not fail by default

A `503` is a returned `Response`, so the operation _succeeded_ as far as Resili is concerned. It is
not retried and does not feed the circuit breaker unless you say so.

```ts
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const resilientFetch = createFetch({
  retry: {
    maxAttempts: 3,
    jitter: "none",
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" && RETRYABLE.has(outcome.value.status)),
  },
});
```

`retryOn` returning `true` for a successful outcome is supported precisely for this case.

If you would rather have statuses behave like errors everywhere — retry, circuit breaker, and
fallback alike — throw from an operation instead of using the adapter:

```ts
import { createClient } from "@resili/core";

const getJson = createClient(
  async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    return (await response.json()) as unknown;
  },
  { retry: { maxAttempts: 3, jitter: "none" }, timeout: { perAttemptMs: 1_000 } },
);
```

## AbortSignal propagation

The adapter reads `init.signal` and passes it to `client.execute`. Each attempt
shallow-copies your `RequestInit` and sets `signal` to composed `ctx.signal`:

```ts
fetchImplementation(input, { ...init, signal: ctx.signal });
```

Timeouts abort that composed signal, so `fetch` closes the socket. A caller
`AbortSignal` on `init` aborts the same logical request. Your original `RequestInit`
is not mutated.

```ts
const controller = new AbortController();

const request = resilientFetch(url, {
  signal: controller.signal,
});

controller.abort();
```

Everything else in `RequestInit` — method, headers, body, credentials, cache, redirect — is preserved.

## Errors

The adapter defines no error types of its own. What you can see:

| Error                                                                | Source                                |
| -------------------------------------------------------------------- | ------------------------------------- |
| Whatever `fetch` rejects with (`TypeError`, cause `ECONNREFUSED`, …) | Network failure, no policy handled it |
| `TimeoutError`                                                       | Per-attempt timeout                   |
| `RetryExceededError`                                                 | Retries exhausted; check `lastError`  |
| `CircuitOpenError`                                                   | Breaker open                          |
| `RateLimitExceededError`, `BulkheadRejectedError`                    | Admission control                     |
| `AbortError` / `DOMException`                                        | Cancellation                          |

Under the default classifier a rejected `fetch` — a generic `Error` — is a **failure but not
retryable**. Network errors are only retryable when the context metadata marks the operation
idempotent:

```ts
// Retries a connection reset
await client.execute((ctx) => fetch(url, { signal: ctx.signal }), {
  metadata: { idempotent: true },
});
```

For the adapter, supply `retryOn` instead. See
[Error classification](../architecture/error-classification.md).

## Differences from calling `fetch` directly

| Behavior        | `fetch`             | `createFetch(...)`                                |
| --------------- | ------------------- | ------------------------------------------------- |
| Return value    | `Response`          | The same `Response`, unwrapped                    |
| Status handling | Resolves on 4xx/5xx | Same — no automatic classification                |
| `init.signal`   | Honored             | Composed into Resili; transport gets `ctx.signal` |
| Timeouts        | Manual              | `timeout.perAttemptMs`, per attempt               |
| Retries         | Manual              | `retry`, opt-in for statuses                      |
| Body on retry   | n/a                 | Same reference reused — single-use bodies break   |
| Response body   | Yours to read       | Untouched and unconsumed                          |
| Events/metrics  | None                | Typed [events](../observability/events.md)        |

## Example: a hardened API client

```ts
import { createFetch } from "@resili/fetch";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const api = createFetch({
  timeout: { perAttemptMs: 2_000 },
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 200,
    maxDelayMs: 2_000,
    jitter: "none",
    respectRetryAfter: true,
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" && RETRYABLE.has(outcome.value.status)),
  },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50, resetTimeoutMs: 15_000 },
  bulkhead: { maxConcurrent: 25, maxQueue: 50, queueTimeoutMs: 500 },
});

export async function getUser(id: string) {
  const response = await api(`https://api.example.com/users/${id}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`user fetch failed: ${response.status}`);
  }
  return (await response.json()) as { id: string; name: string };
}
```

## Limitations

- No automatic status classification.
- No response body transformation, parsing, or cloning.
- Caller `init.signal` is composed into Resili execution; fetch receives `ctx.signal`.
- Single-use request bodies are unsafe to retry.
- No base URL, default headers, or interceptor concept — compose those yourself around the adapter.
