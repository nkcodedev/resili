# @resili/fetch example

Retrying a failing HTTP endpoint through a fetch-compatible client.

**No credentials and no outbound network access required.** The example starts a local HTTP server on
an ephemeral port that returns 503 twice before succeeding.

This directory is not a workspace package and is not executed in CI.

## Run it

From a clone of Resili, after `pnpm build`:

```bash
cd examples/fetch
pnpm add @resili/core@file:../../packages/core @resili/fetch@file:../../packages/fetch
node example.mjs
```

## What it shows

The important detail is that **HTTP status codes are not failures by default**. The adapter returns
the `Response`, so a 503 looks like a success to the pipeline and nothing is retried. The example opts
in with `retry.retryOn`:

```js
retryOn(outcome) {
  return outcome.status === "success" && outcome.value.status >= 500;
}
```

It also notes what you cannot do: the adapter replaces `init.signal` with the Resili context signal
and exposes no per-call options, so caller-initiated cancellation is not available through it. Wrap
the call with `@resili/core` directly if you need that.

## Documentation

- [fetch adapter guide](../../docs/http/fetch.md)
- [HTTP adapters overview](../../docs/http/overview.md)
- [Error classification](../../docs/architecture/error-classification.md)
