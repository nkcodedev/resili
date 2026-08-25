# @resili/undici example

Retrying a failing HTTP endpoint through undici's `request`.

**No credentials and no outbound network access required.** The example starts a local HTTP server on
an ephemeral port that returns 503 twice before succeeding.

This directory is not a workspace package and is not executed in CI.

## Run it

From a clone of Resili, after `pnpm build`:

```bash
cd examples/undici
pnpm add undici @resili/core@file:../../packages/core @resili/undici@file:../../packages/undici
node example.mjs
```

## What it shows

`undici` is **not** a dependency or peer dependency of `@resili/undici`. You inject the `request`
function, so you control the version and any dispatcher configuration.

Three details specific to undici:

- Requests take `origin` and `path` separately rather than a single URL.
- The status field is `statusCode`, not `status`.
- **Every response body must be consumed or the connection leaks.** `retry.retryOn` is synchronous, so
  it cannot drain the body of a response it discards. The example wraps `request` and calls
  `body.dump()` on 5xx responses before the retry decision is made.

The adapter does not disable retry behavior in what you inject — a `RetryAgent` would retry inside
each Resili attempt.

## Documentation

- [undici adapter guide](../../docs/http/undici.md)
- [HTTP adapters overview](../../docs/http/overview.md)
- [Error classification](../../docs/architecture/error-classification.md)
