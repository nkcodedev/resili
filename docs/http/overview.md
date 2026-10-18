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

| Package                       | Wraps                          | Version      |
| ----------------------------- | ------------------------------ | ------------ |
| [`@resili/fetch`](fetch.md)   | A fetch-compatible function    | `0.2.0-rc.1` |
| [`@resili/axios`](axios.md)   | An axios-compatible function   | `0.2.0-rc.1` |
| [`@resili/undici`](undici.md) | An undici-compatible `request` | `0.2.0-rc.1` |

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

## Status codes and policies

Adapters return the transport response object. A `503` is still a **successful** Core outcome
(the operation returned a value). Retry and Circuit Breaker use that outcome differently:

| Policy              | Default behavior for resolved responses                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Retry**           | **Does not** auto-retry by HTTP status. Opt in with `retryOn` (or a custom classifier).                           |
| **Circuit breaker** | Treats selected `.status` values (`408`, `500`, `502`, `503`, `504`) as failures. `429` is not a breaker failure. |

Undici responses expose **`statusCode`**, not `.status`. The default classifier reads `.status`
only, so undici status codes are invisible unless you opt in with `retryOn` / a custom classifier.

```ts
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const resilientFetch = createFetch({
  retry: {
    maxAttempts: 3,
    jitter: "none",
    // Explicit opt-in: only enable this for operations that are safe to repeat.
    retryOn: (outcome) =>
      outcome.status === "error" ||
      (outcome.status === "success" && RETRYABLE.has(outcome.value.status)),
  },
});
```

Timeouts and some thrown transport errors can still cause retries. That may repeat
non-idempotent work (for example `POST`). Prefer idempotency keys or server-side
deduplication when duplicate side effects are unacceptable.

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

## Cancellation and caller `AbortSignal`

Each adapter reads the caller `signal` from the existing call shape (`init.signal`,
`config.signal`, or `options.signal`) and passes it to `client.execute` as
`ContextInit.signal`. Core composes that with timeout and other policy signals.
The copy sent to the HTTP implementation uses `ctx.signal`, not the original
caller signal. Caller objects are not mutated.

```ts
const controller = new AbortController();

const request = resilientFetch(url, {
  signal: controller.signal,
});

controller.abort();
```

Abort remains non-retryable. AbortSignal is the only supported cancellation
mechanism. See [Cancellation](../core/cancellation.md).

## Lifecycle: `on` and `destroy`

Each adapter return value is still callable like the underlying client, and also
exposes Core lifecycle hooks:

- `on(type, handler)` — subscribe to Core events (`RequestStarted`, `RetryStarted`, …); returns the same unsubscribe function Core uses
- `destroy()` — idempotent cleanup of the inner client

Adapters do **not** expose the full Core `Client` (`call`, `execute`, `stats`, `health`).

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
