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

`demo.mjs` is the same two scenes with the retry delay used in the README GIF:

```bash
node demo.mjs
```

Open the folder in StackBlitz:

https://stackblitz.com/fork/github/nkcodedev/resili/tree/main/examples/stackblitz?file=index.mjs&title=Resili

That import is only this directory. It installs published `@resili/core@0.2.0-rc.2`. After install, run `node index.mjs`.
