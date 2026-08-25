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

Pricing numbers below are **example configuration**, not OpenAI's current price list.
