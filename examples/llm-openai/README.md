# OpenAI + Resili example

This example is **not** run in CI. It needs a real `OPENAI_API_KEY`.

## Setup

This directory is not a workspace package and is not executed in CI.

From a clone of Resili, after `pnpm build`:

```bash
cd examples/llm-openai
cp .env.example .env
# put your key in .env — never commit .env
pnpm add openai @resili/llm@file:../../packages/llm @resili/llm-openai@file:../../packages/llm-openai
node --env-file=.env example.mjs
node --env-file=.env stream.mjs
```

`example.mjs` uses `llm.generate()`; `stream.mjs` runs the same request through `llm.stream()`.

Pricing numbers in these files are **example configuration**, not OpenAI's current price list. Resili
ships no price table.

## Documentation

- [OpenAI provider guide](../../docs/providers/openai.md)
- [generate()](../../docs/llm/generate.md) · [Streaming](../../docs/llm/streaming.md) ·
  [Budget Guard](../../docs/llm/budget-guard.md)
- [All examples](../README.md)
