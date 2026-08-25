# @resili/llm

> Provider-neutral LLM resilience, usage accounting, cost control, and observability for Resili.

`@resili/llm` is the LLM foundation package for [Resili](../../README.md). It normalizes generation requests, classifies provider-neutral failures, accounts for token usage, calculates cost from **your** price table, and enforces an in-memory Budget Guard.

It is **not** an AI SDK. It does not call OpenAI, Anthropic, Gemini, or any other vendor. It does not ship prompt templates, agents, RAG, embeddings, or moderation.

[`@resili/llm-openai`](../llm-openai/README.md) is the first official adapter: it wraps a **user-owned** OpenAI client and returns the contracts defined here.

## Installation

```bash
pnpm add @resili/core @resili/llm
```

```bash
npm install @resili/core @resili/llm
```

```bash
yarn add @resili/core @resili/llm
```

Node.js 20 or newer is required. `@resili/llm` depends only on `@resili/core` at runtime.

## What this package is responsible for

- Provider-neutral `LlmRequest` / `LlmResponse` / `LlmUsage` contracts
- Normalized LLM errors and retryability
- Deterministic cost calculation from an injectable price table
- Budget Guard (per-request and accumulated, in-memory)
- Typed LLM lifecycle events
- Low-cardinality LLM metrics on Resili's `MetricsRecorder`

Reuse `@resili/core` for timeout, retry, circuit breaker, rate limiting, bulkhead, and fallback. Pass those fields through `createLlmClient()`.

## Minimal example

```ts
import { createLlmClient, createPricingResolver, defineProvider } from "@resili/llm";

const provider = defineProvider({
  name: "example",

  async execute(request, ctx) {
    void ctx.signal;
    // Future provider adapters normalize their SDK here.
    return {
      provider: "example",
      model: request.model,
      content: "response",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      finishReason: "stop",
    };
  },
});

const llm = createLlmClient({
  provider,
  model: "model-a",
  timeout: { perAttemptMs: 10_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "example",
      model: "model-a",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]),
  budget: {
    maxCostPerRequestUsd: 0.25,
    maxAccumulatedCostUsd: 10,
  },
});

const result = await llm.generate({
  input: "Hello",
  estimatedInputTokens: 100,
  estimatedOutputTokens: 50,
});

result.usage.totalTokens;
result.cost?.totalCostUsd;
```

## Provider-neutral architecture

`defineProvider()` is the only execution boundary. Adapters should:

1. Close over API keys in the adapter. Never put secrets on `LlmRequest`.
2. Honor `ctx.signal` for cancellation and timeouts.
3. Translate vendor errors into `LlmError` with a `classification` and `cause`.
4. Return normalized `LlmUsage` (missing counts become zero).

This package never performs network I/O of its own.

## Usage accounting

`LlmUsage` always has `inputTokens`, `outputTokens`, and `totalTokens`. Extra numeric dimensions may be placed on `usage.dimensions` without a breaking change. Cost calculation currently uses input and output tokens only.

## Configurable pricing

Resili does **not** hard-code vendor prices. Supply a `PricingResolver`, typically `createPricingResolver(rows)`.

Costs are computed in **integer micro-USD** (`1 USD = 1_000_000 micro-USD`) with round-half-up, then exposed as:

| Field               | Use for                          |
| ------------------- | -------------------------------- |
| `totalCostMicroUsd` | Budgets, comparisons, metrics    |
| `totalCostUsd`      | Display (`microUsd / 1_000_000`) |

Unknown provider/model pairs resolve to `undefined` cost on the generate result. That is **not** `$0`.

When Budget Guard is enabled, `onUnknownPricing` controls the behavior:

| Value      | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `"reject"` | **Default.** Fail closed. The request is rejected with `limitKind: "unknown-pricing"`. |
| `"allow"`  | Explicit fail-open. Skip cost preflight and budget accounting for that request.        |

`createLlmClient({ budget, ... })` with the default `"reject"` requires a `pricing` resolver. Do not omit pricing and expect the guard to treat missing prices as free.

## Budget Guard

Configure `budget` on `createLlmClient()`:

- `maxCostPerRequestUsd` — compared to **preflight estimated** cost (`estimatedInputTokens` / `estimatedOutputTokens`) **before** the provider is called. This is not a hard ceiling on actual spend: output tokens are unknown until the provider returns, so actual cost can exceed the estimate.
- `maxAccumulatedCostUsd` — compared to committed spend plus in-flight **reservations** of the estimated cost. After the call, the reservation is replaced with actual cost.
- `onUnknownPricing` — `"reject"` (default) or `"allow"`. See [Configurable pricing](#configurable-pricing).
- Limits are inclusive (estimated cost exactly at the cap is allowed)
- `scope` — string or `(request, ctx) => string` so you can encode tenant/user/day later
- `accountant` — inject your own ledger; the default is process-local memory

Lifecycle:

```text
estimate (known price only)
→ budget preflight
→ reserve estimated cost (accumulated cap, same process)
→ provider execution
→ actual usage / actual cost
→ settle reservation (commit actual, or 0 on failure)
```

Rejected calls throw `LlmBudgetExceededError` and emit `LlmBudgetRejected`. There is no Redis or distributed accounting in this release.

Process-local concurrency: `reserve` / `settle` are synchronous, so two overlapping `generate()` calls cannot both reserve the last remaining budget. Custom accountants must preserve that atomicity. Concurrent requests **without** useful estimates can still overshoot because a `$0` reservation does not block actual spend.

## Events and metrics

LLM events (`llm.on`):

- `LlmRequestStarted`
- `LlmRequestCompleted`
- `LlmRequestFailed`
- `LlmUsageRecorded`
- `LlmBudgetWarning`
- `LlmBudgetRejected`

Core policy events (timeout, retry, circuit breaker, …) are available on `llm.onCore(...)`.

Metrics use Resili's `MetricsRecorder`. The only label is `result` = `success` | `failure` | `budget_rejected`. Prompt text, user ids, request ids, and model names are never metric dimensions.

## Security and privacy

- API keys must stay in your adapter closure. They are never persisted by Resili.
- Events, metrics, and Resili-generated error messages do not include prompts, completions, or authorization headers.
- This package makes no outbound calls and does not contact a Resili service.

## Current alpha limitations

- Official adapters: [`@resili/llm-openai`](../llm-openai/README.md) (Chat Completions) and [`@resili/llm-anthropic`](../llm-anthropic/README.md) (Messages). No Gemini, Azure, or Bedrock adapters yet
- Budget accounting is in-memory per client (or per injected `BudgetAccountant`); reservations are process-local, not distributed
- `maxCostPerRequestUsd` is an estimated-cost preflight, not a hard actual-cost ceiling
- Concurrent requests with missing estimates can overshoot `maxAccumulatedCostUsd` after execution
- Hedged/cached LLM semantics are not specialized beyond core policies
- `usage.dimensions` are recorded but not priced
- Core's public event map is closed; LLM events are a typed bus on this package
- `{ after: "cache" }` and `{ before: "cache" }` are valid `@resili/core` relative order anchors. Budget Guard still uses `{ before: "retry" }` (resolved order `199.5`, between cache `150` and retry `200`).

## License

MIT
