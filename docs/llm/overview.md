# `@resili/llm` overview

`@resili/llm` applies Resili's resilience model to LLM calls. It normalizes requests and responses,
classifies provider failures, accounts for token usage, computes cost from **your** price table,
enforces a budget, and emits privacy-safe telemetry.

Current version: **`0.1.0-alpha.4`**. Depends only on `@resili/core`.

## Architecture

```text
Application
    ↓
@resili/llm                    contracts, classification, usage, pricing, budget, telemetry
    ↓
Resili execution / policies    retry, timeout, circuit breaker, rate limiter, bulkhead, fallback
    ↓
Provider adapter               @resili/llm-openai | -anthropic | -gemini
    ↓
Provider SDK                   openai | @anthropic-ai/sdk | @google/genai
```

`@resili/llm` performs no network I/O. It never constructs a vendor client and never reads an API key.
You build the SDK client; the adapter maps it to a provider-neutral contract.

## What it is not

Not an AI SDK. There are no prompt templates, no agents, no tool-calling orchestration, no RAG, no
embeddings, no moderation, and no vendor price tables. It is the resilience, cost, and observability
layer beneath whichever of those you choose to use.

## Design principle: Resili owns resilience

Every official provider adapter **disables the SDK's own retry mechanism**:

| Adapter                 | How                                           |
| ----------------------- | --------------------------------------------- |
| `@resili/llm-openai`    | `maxRetries: 0` on every request              |
| `@resili/llm-anthropic` | `maxRetries: 0` on every request              |
| `@resili/llm-gemini`    | `config.httpOptions.retryOptions.attempts: 1` |

Without this you get two independent retry loops. Three SDK retries inside three Resili attempts is
nine calls, with delays neither layer knows about, a circuit breaker that sees one failure instead of
nine, and a budget guard whose reservation covers a fraction of the real spend.

With one owner, retry composes correctly with the timeout, the breaker, the classifier, and the
budget. This is the opposite of the [HTTP adapters](../http/overview.md#not-feature-parity), which do
not disable anything in the client you inject — there, disabling is your responsibility.

## `createLlmClient()`

```ts
interface CreateLlmClientOptions extends Omit<ResiliConfig<LlmResponse>, "metrics"> {
  readonly provider: LlmProvider;
  readonly model?: string;
  readonly pricing?: PricingResolver;
  readonly budget?: BudgetGuardOptions;
  readonly metrics?: MetricsRecorder;
}
```

Five LLM-specific keys. Remaining Core policy fields (`retry`, `timeout`, and so on) are passed to
`createClient`. `metrics` is **LLM-only** (`resili_llm_*`); it is not Core policy metrics injection.

| Key        | Required | Purpose                                                          |
| ---------- | -------- | ---------------------------------------------------------------- |
| `provider` | yes      | The adapter. Must expose `execute`; `stream` is optional.        |
| `model`    | no       | Default model when the request omits one.                        |
| `pricing`  | no       | Price table. Required when `budget` uses the default `"reject"`. |
| `budget`   | no       | [Budget Guard](budget-guard.md) limits.                          |
| `metrics`  | no       | LLM `MetricsRecorder` only. Not forwarded to Core policies.      |

```ts
import OpenAI from "openai";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.05, maxAccumulatedCostUsd: 25 },
});
```

Model resolution: the request's `model` (trimmed) wins, then the client's `model`. If neither
resolves to a non-empty string, a `ConfigurationError` is thrown.

## The client

```ts
interface LlmClient {
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
  stream(request: LlmGenerateRequest): LlmStream;
  on<T extends LlmEventType>(type: T, handler: LlmEventHandler<T>): LlmUnsubscribe;
  onCore<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  destroy(): Promise<void>;
}
```

`on` subscribes to LLM events; `onCore` subscribes to core policy events such as `RetryStarted` and
`TimeoutTriggered`. Two buses, because core's event map is closed and LLM events are additive.

- [`generate()`](generate.md) — unary
- [`stream()`](streaming.md) — pull-through streaming

## Pipeline placement

Configured policies compose as usual, with the Budget Guard registered at `{ before: "retry" }`:

```text
fallback → cache → llm-budget → retry → circuit-breaker → timeout → … → provider
```

One reservation covers the whole logical request, so retries do not each reserve budget. See
[Policy ordering](../core/policy-ordering.md).

## Provider abstraction

```ts
interface LlmProvider {
  readonly name: string;
  execute(request: LlmRequest, ctx: Context): Promise<LlmResponse>;
  stream?(request: LlmRequest, ctx: Context): Promise<AsyncIterable<LlmProviderStreamFrame>>;
}
```

`defineProvider()` validates and freezes a provider. `stream` is optional; calling `client.stream()`
on a provider without it throws a `ConfigurationError`.

A provider adapter has four jobs: honor `ctx.signal`, disable SDK retries, map vendor errors to
[`LlmError`](errors.md) with a classification, and return normalized [usage](usage.md).

```ts
import { defineProvider } from "@resili/llm";

const echo = defineProvider({
  name: "echo",
  async execute(request, ctx) {
    ctx.signal.throwIfAborted();
    return {
      provider: "echo",
      model: request.model,
      content: request.input,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      finishReason: "stop",
    };
  },
});
```

Official adapters: [OpenAI](../providers/openai.md), [Anthropic](../providers/anthropic.md),
[Gemini](../providers/gemini.md).

## Usage, pricing, and cost

Provider usage is normalized to `inputTokens` / `outputTokens` / `totalTokens`, with vendor-specific
counts preserved under `usage.dimensions`. Cost is computed in integer **micro-USD** from a price
table you supply — Resili hard-codes no vendor prices, and an unknown provider/model pair yields
`undefined` cost, not `$0`.

See [Usage](usage.md) and [Pricing](pricing.md).

## Budget Guard

Estimated cost is checked and reserved before the provider runs, then settled against authoritative
usage afterwards. Accounting is process-local. See [Budget Guard](budget-guard.md).

## Errors

`LlmError` carries a `classification`, a `retryable` flag, and the original SDK error as `cause`.
Twelve classifications are implemented. See [Errors](errors.md).

## Telemetry

Nine LLM event types, fifteen metric names, one metric label (`result`). No prompts, completions,
chunks, or credentials appear in any event or metric payload. See
[Telemetry and privacy](../observability/telemetry.md).

## Continue

- [generate()](generate.md) · [Streaming](streaming.md)
- [Retries](retries.md) · [Timeouts](timeouts.md) · [Cancellation](cancellation.md)
- [Budget Guard](budget-guard.md) · [Pricing](pricing.md) · [Usage](usage.md) · [Errors](errors.md)
