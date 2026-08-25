# @resili/llm-openai

> OpenAI Chat Completions adapter for the Resili LLM foundation.

**Public alpha.** This package is the first provider adapter for [`@resili/llm`](../llm/README.md). It is **not** an OpenAI SDK replacement and not an agent framework.

You create the official `openai` client. Resili never stores API keys and never contacts a Resili service.

## Installation

```bash
pnpm add @resili/core @resili/llm @resili/llm-openai openai
```

Node.js 20 or newer is required for Resili. The official `openai` SDK **v7** declares `node >= 22`. Use SDK v4–v6 on Node 20, or Node 22+ with v7.

You supply the OpenAI SDK client. This package does not depend on `openai` at runtime (optional peer `openai >= 4.0.0`). The adapter is **structural** and was inspected against **`openai@7.5.0`**. It supports **Chat Completions only**. It sets **`maxRetries: 0`** on every SDK call so **Resili owns retries**.

## Relationship to `@resili/llm`

`@resili/llm` owns contracts, pricing, Budget Guard, events, and metrics.

`@resili/llm-openai` only:

1. maps `LlmRequest` → OpenAI Chat Completions;
2. maps the completion → `LlmResponse` / `LlmUsage`;
3. maps SDK/HTTP failures → `LlmError`;
4. passes Resili's `AbortSignal` into the SDK call with **`maxRetries: 0`**.

## OpenAI client setup

```ts
import OpenAI from "openai";
import { createOpenAiProvider } from "@resili/llm-openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const provider = createOpenAiProvider({
  client: openai,
  model: "gpt-4.1-mini",
});
```

Pass a user-owned client. Do not put keys on `LlmRequest`.

## Basic usage

```ts
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";
import OpenAI from "openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({
    client: new OpenAI(),
    model: "gpt-4.1-mini",
  }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 10_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  // Example configuration only — not OpenAI's live price list.
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
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
  estimatedInputTokens: 20,
  estimatedOutputTokens: 50,
});

result.usage.totalTokens;
result.cost?.totalCostUsd;
```

## Streaming

`llm.stream()` uses Chat Completions `stream: true` and `stream_options.include_usage: true` on the raw iterable (not an accumulator helper). SDK `maxRetries` remains `0`. `timeout.perAttemptMs` is the full stream attempt including consumer pull wait.

Retries follow `@resili/llm`: only before the first yielded non-empty text. Interrupted streams may omit billed tokens from Resili usage.

See `examples/llm-openai/stream.mjs`.

## Retry ownership

The official OpenAI Node SDK retries **2 times by default** (connection errors, 408, 409, 429, and 5xx).

This adapter sets **`maxRetries: 0` on every Chat Completions call** so Resili remains the only retry engine when you use `createLlmClient({ retry })`.

If you need SDK-side retries, do not combine them with Resili retry, or you will multiply attempts.

## Timeout and cancellation

Resili's timeout policy aborts `ctx.signal`. The adapter passes that signal to `chat.completions.create(..., { signal })`.

User `AbortSignal` on `generate({ signal })` is composed by `@resili/core` into the same context signal.

## Budget Guard and pricing

Budget Guard and pricing live in `@resili/llm`. This adapter only returns normalized usage.

Flow:

```text
estimate → Budget Guard → OpenAI Chat Completions → actual usage → actual cost → accounting
```

Do not hard-code vendor prices here. Example USD amounts in this README are **illustrative**.

## Error normalization

| OpenAI / HTTP                        | `LlmError.classification` | Retryable |
| ------------------------------------ | ------------------------- | --------- |
| 401 / `AuthenticationError`          | `authentication`          | no        |
| 403 / `PermissionDeniedError`        | `authorization`           | no        |
| 400 / 404 / 422                      | `invalid_request`         | no        |
| `context_length_exceeded`            | `context_limit_exceeded`  | no        |
| `content_filter`                     | `content_policy`          | no        |
| 429 / `RateLimitError`               | `rate_limited`            | yes       |
| `APIConnectionTimeoutError`          | `timeout`                 | yes       |
| `APIConnectionError` / network codes | `network_transient`       | yes       |
| 503                                  | `overloaded`              | yes       |
| 5xx                                  | `provider_unavailable`    | yes       |
| other                                | `unknown`                 | no        |

`cause` is a sanitized snapshot (`status`, `code`, `type`, `requestID`). It does not include headers, bodies, prompts, or API keys.

## Security and privacy

- No default logging.
- Events and metrics come from `@resili/llm` and do not include prompts or completions.
- Normalized error messages are classification text only.

## Alpha limitations

- Chat Completions only (no Responses API, Assistants, embeddings, or images). Unary `generate()` and pull-through `stream()` are supported. Streaming reads `choices[0]` only.
- Single user message from `LlmRequest.input`
- No tool calls, vision, or JSON-schema mapping
- Missing OpenAI `usage` becomes zero counts (the `LlmUsage` contract requires numbers; tokens are not estimated)

## License

MIT
