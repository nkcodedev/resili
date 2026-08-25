# Anthropic + Resili example

This example is **not** run in CI. It needs a real `ANTHROPIC_API_KEY`.

## Setup

This directory is not a workspace package and is not executed in CI.

From a clone of Resili, after `pnpm build`:

```bash
cd examples/llm-anthropic
cp .env.example .env
# put your key in .env — never commit .env
pnpm add @anthropic-ai/sdk @resili/llm@file:../../packages/llm @resili/llm-anthropic@file:../../packages/llm-anthropic
node --env-file=.env example.mjs
```

`example.mjs` uses `llm.generate()`; `stream.mjs` runs the same request through `llm.stream()`.

Pricing numbers in these files are **example configuration**, not Anthropic's current price list.
Resili ships no price table.

## Documentation

- [Anthropic provider guide](../../docs/providers/anthropic.md)
- [generate()](../../docs/llm/generate.md) · [Streaming](../../docs/llm/streaming.md) ·
  [Budget Guard](../../docs/llm/budget-guard.md)
- [All examples](../README.md)
