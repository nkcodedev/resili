# StackBlitz-style example

A one-folder project that depends on published `@resili/core@0.2.0-rc.2`. It does not use the monorepo workspace.

The script retries a local function until it succeeds. A plain `Error` is not retryable unless `retryOn` opts in, so the example supplies that predicate. It then opens a circuit breaker on a function that always throws. The second guarded call does not enter that function.

## Run locally

```bash
cd examples/stackblitz
npm install
node index.mjs
```

Node.js 20 or newer. No API keys.

This directory is not linked from a live StackBlitz URL. Open the folder in StackBlitz only after `node index.mjs` prints the retry result and `ERR_CIRCUIT_OPEN`.
