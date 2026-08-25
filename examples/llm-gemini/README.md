# Local Gemini example

Not run in CI. Requires a Gemini Developer API key.

```bash
cd examples/llm-gemini
cp .env.example .env
# set GEMINI_API_KEY in .env, then:
pnpm add @google/genai @resili/llm@file:../../packages/llm @resili/llm-gemini@file:../../packages/llm-gemini
node --env-file=.env example.mjs
```

`stream.mjs` runs the same request through `llm.stream()`.

Pricing rows in `example.mjs` are **illustrative**, not Google's live price list. Resili ships no
price table.

This adapter targets `@google/genai`, not the legacy `@google/generative-ai` SDK.

## Documentation

- [Gemini provider guide](../../docs/providers/gemini.md)
- [Streaming](../../docs/llm/streaming.md) · [Budget Guard](../../docs/llm/budget-guard.md) ·
  [Pricing](../../docs/llm/pricing.md)
- [All examples](../README.md)
