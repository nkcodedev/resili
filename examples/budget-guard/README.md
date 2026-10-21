# Budget Guard example

Shows `LlmBudgetExceededError` when the estimated cost is above `maxCostPerRequestUsd`. The provider function is local. No API key is read and no network call is made.

`maxCostPerRequestUsd` compares the estimate only. It does not cap actual token usage after a provider responds.

## Run

From the repository root, after `@resili/llm` has been built:

```bash
pnpm --filter @resili/llm build
node examples/budget-guard/example.mjs
```

Expected output includes `provider calls: 0` and `limit kind: per-request`.
