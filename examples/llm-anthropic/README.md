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

Pricing numbers in `example.mjs` are **example configuration**, not Anthropic's current price list.
