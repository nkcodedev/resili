# Local Gemini example

Not run in CI. Requires a Gemini Developer API key.

```bash
cd examples/llm-gemini
cp .env.example .env
# set GEMINI_API_KEY in .env, then:
pnpm add @google/genai @resili/llm@file:../../packages/llm @resili/llm-gemini@file:../../packages/llm-gemini
node --env-file=.env example.mjs
```

Pricing rows in `example.mjs` are **illustrative**, not Google's live price list.
