# HTTP adapters

Three adapters wrap an HTTP client in a Resili pipeline while keeping its call shape.

```text
Application
    ↓
adapter          (@resili/fetch | @resili/axios | @resili/undici)
    ↓
@resili/core     policies
    ↓
HTTP client      globalThis.fetch | your axios | your undici
```

| Package                       | Wraps                          | Version         |
| ----------------------------- | ------------------------------ | --------------- |
| [`@resili/fetch`](fetch.md)   | A fetch-compatible function    | `0.2.0-alpha.3` |
| [`@resili/axios`](axios.md)   | An axios-compatible function   | `0.2.0-alpha.3` |
| [`@resili/undici`](undici.md) | An undici-compatible `request` | `0.2.0-alpha.3` |

## What they have in common

All three are deliberately thin. Each one:

- accepts the full [`ResiliConfig`](../core/overview.md#client-config) plus a single adapter-specific
  key, strips that key, and hands the rest to `createClient`
- shallow-copies your request arguments per attempt and never mutates the object you passed
- sets the request's signal field to `ctx.signal`, so timeouts and cancellation reach the transport
- returns whatever the underlying client returned, unwrapped and untransformed
- propagates errors from the underlying client unchanged

None of them bundles the library it wraps. `@resili/fetch` defaults to `globalThis.fetch`;
`@resili/axios` and `@resili/undici` require you to inject an implementation. There are **no peer
dependencies** on `axios` or `undici` — the adapters describe those APIs structurally, so you stay in
control of the version, the instance, and its configuration.

## Choosing one

| Use                                                     | Adapter          |
| ------------------------------------------------------- | ---------------- |
| Node's built-in `fetch`, or any fetch-compatible client | `@resili/fetch`  |
| An existing axios instance with your interceptors       | `@resili/axios`  |
| `undici.request` directly, for lower-level control      | `@resili/undici` |

## Status codes are not classified by default

This is the most important thing to understand before using an adapter.

Resili treats "the operation returned a value" as success. An HTTP adapter returns the response
object, and a `503` is still a returned response — so **by default a 5xx is not retried and does not
open the circuit breaker**.

The default `httpClassifier` knows how to interpret statuses, but the adapters do not throw or
convert on status. To act on statuses, opt in with `retryOn`:

```ts
const resilientFetch = createFetch({
  retry: {
    maxAttempts: 3,
    jitter: "none",
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" &&
        [408, 429, 500, 502, 503, 504].includes(outcome.value.status)),
  },
});
```

Or throw from the operation, which converts a bad status into a failure that every policy understands:

```ts
const client = createClient(
  async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  },
  { retry: { maxAttempts: 3, jitter: "none" } },
);
```

## Cancellation, and the signal you cannot pass

Each adapter overwrites the signal on your request arguments with `ctx.signal`:

```ts
// The adapter replaces this signal. It has no effect.
await resilientFetch(url, { signal: controller.signal });
```

The adapters call `client.execute(operation)` without a `ContextInit`, so there is no seam for a
caller signal either. **Caller-initiated cancellation is not supported through the HTTP adapters in
this alpha.** Timeout-driven cancellation works normally — that is exactly what the overwritten signal
carries.

If you need to abort a request from the caller, wrap the HTTP call with `@resili/core` directly, where
`execute` does take a per-call signal:

```ts
import { createClient } from "@resili/core";

const client = createClient(() => undefined, {
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const controller = new AbortController();

// ctx.signal is aborted by the caller, the timeout, or both.
const response = await client.execute((ctx) => fetch(url, { signal: ctx.signal }), {
  signal: controller.signal,
});
```

See [Cancellation](../core/cancellation.md).

## Request bodies and retries

Adapters re-invoke the underlying client with the **same body reference** on each attempt. They do not
clone, buffer, or rewind it.

For strings, `Buffer`s, and plain objects this is fine. For a single-use body — a stream, or a
`ReadableStream` in a `fetch` `RequestInit` — the second attempt will fail or send nothing, because
the body was already consumed. Retry only requests whose bodies can be re-read.

Response bodies are likewise untouched: the adapter never reads or clones them, so the body you
receive is unconsumed and yours to read once.

## Not feature parity

The three adapters are not interchangeable, and none of them is a drop-in replacement for the full
library it wraps.

| Capability                         | fetch                         | axios                           | undici                          |
| ---------------------------------- | ----------------------------- | ------------------------------- | ------------------------------- |
| Implementation injection           | Optional (`globalThis.fetch`) | **Required**                    | **Required**                    |
| Call shape                         | `(input, init?)`              | Callable + verb helpers         | `(options)`                     |
| Verb helpers (`get`, `post`, …)    | No                            | Yes                             | No                              |
| Returned object                    | `Response`                    | `AxiosResponse` (frozen client) | `UndiciResponse` (`statusCode`) |
| Requires `origin` + `path`         | No                            | No                              | Yes                             |
| Underlying client's retry disabled | n/a                           | No                              | **No**                          |

That last row deserves emphasis. Unlike the LLM provider adapters — which explicitly disable SDK-level
retries so Resili owns retry behavior — **the HTTP adapters do not disable anything in the underlying
client**. If you inject an axios instance with `axios-retry` installed, or an undici dispatcher
configured with retries, those retries run _inside_ each Resili attempt and multiply with Resili's
own. Disable them in the client you inject.

Beyond that, `@resili/axios` implements no interceptors, transforms, cancel tokens, or
`axios.create()`, and `@resili/undici` implements no `Agent`, `Pool`, `Dispatcher`, `MockAgent`,
`ProxyAgent`, WebSocket, or body helpers. Configure those on the instance you inject.

## Pages

- [fetch adapter](fetch.md)
- [axios adapter](axios.md)
- [undici adapter](undici.md)
