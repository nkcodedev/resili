# @resili/axios example

Retrying a failing HTTP endpoint through an axios instance you own.

**No credentials and no outbound network access required.** The example starts a local HTTP server on
an ephemeral port that returns 503 twice before succeeding.

This directory is not a workspace package and is not executed in CI.

## Run it

From a clone of Resili, after `pnpm build`:

```bash
cd examples/axios
pnpm add axios @resili/core@file:../../packages/core @resili/axios@file:../../packages/axios
node example.mjs
```

## What it shows

`axios` is **not** a dependency or peer dependency of `@resili/axios`. You create the instance and
inject it, so `baseURL`, headers, and interceptors stay yours.

Two things worth noticing:

- axios rejects on non-2xx by default. The example sets `validateStatus: () => true` so the response
  stays a value, letting `retry.retryOn` inspect `status` instead of the pipeline seeing an error.
- The adapter does **not** disable retry behavior inside your instance. A retry interceptor would run
  inside each Resili attempt, multiplying the total request count.

The returned client is callable and also provides `request`, `get`, `delete`, `post`, `put`, and
`patch` — all through the same pipeline.

## Documentation

- [axios adapter guide](../../docs/http/axios.md)
- [HTTP adapters overview](../../docs/http/overview.md)
- [Error classification](../../docs/architecture/error-classification.md)
