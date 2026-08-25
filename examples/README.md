# Examples

Runnable, self-contained examples. None of these are workspace packages and none are executed in CI.

## Index

| Example                            | Needs credentials   | Needs network | Shows                                                                     |
| ---------------------------------- | ------------------- | ------------- | ------------------------------------------------------------------------- |
| [`core`](./core)                   | No                  | No            | Retry, timeout, breaker, fallback, cancellation on a plain async function |
| [`fetch`](./fetch)                 | No                  | No            | Status-code retry through a fetch-compatible client                       |
| [`axios`](./axios)                 | No                  | No            | An axios instance you own, injected                                       |
| [`undici`](./undici)               | No                  | No            | `origin`/`path`, `statusCode`, body draining on retry                     |
| [`llm-openai`](./llm-openai)       | `OPENAI_API_KEY`    | Yes           | `generate()` and `stream()` against OpenAI                                |
| [`llm-anthropic`](./llm-anthropic) | `ANTHROPIC_API_KEY` | Yes           | `generate()` and `stream()` against Anthropic                             |
| [`llm-gemini`](./llm-gemini)       | `GEMINI_API_KEY`    | Yes           | `generate()` and `stream()` against Gemini                                |

The four non-LLM examples start a local HTTP server on an ephemeral port, or use a local function, so
they run offline with no accounts involved.

## Running an example

Each directory has its own README with exact commands. The pattern is the same: build the workspace,
then install the local packages into the example directory.

```bash
pnpm install
pnpm build

cd examples/core
pnpm add @resili/core@file:../../packages/core
node example.mjs
```

You can also install from npm instead of the local build:

```bash
pnpm add @resili/core@alpha
```

## Credentials

The three LLM examples need a real API key and make billable provider calls. Each has a
`.env.example` containing an **empty placeholder only** — no real keys are committed anywhere in this
repository.

```bash
cd examples/llm-openai
cp .env.example .env
# put your key in .env — never commit .env
node --env-file=.env example.mjs
```

Resili never reads an environment variable or constructs a provider client. You create the SDK client
and pass it in, so credentials stay in your code.

Pricing rows in the LLM examples are **illustrative configuration**, not any vendor's current price
list. Resili ships no price table.

## LLM streaming

The `stream.mjs` files are the ones worth reading closely, since streaming semantics are the newest
part of the alpha:

- Nothing executes until you start iterating. `result()` alone does not open the provider stream.
- `timeout.perAttemptMs` covers the **whole** streaming attempt, including time your consumer spends
  between pulls.
- Once the first non-empty text delta reaches you the stream is _committed_, and Resili will not start
  another provider generation. See [the commit point](../docs/llm/streaming.md#the-commit-point).

## Documentation

Full documentation is in [`docs/`](../docs/README.md). Start with
[Quick start](../docs/getting-started/quick-start.md).
