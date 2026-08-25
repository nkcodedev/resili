# @resili/llm-anthropic

> Anthropic Messages adapter for the Resili LLM foundation.

**Public alpha.** This package is a provider adapter for [`@resili/llm`](../llm/README.md). It is **not** an Anthropic SDK replacement and not an agent framework.

You create the official `@anthropic-ai/sdk` client. Resili never stores API keys and never contacts a Resili service.

## Installation

```bash
pnpm add @resili/core @resili/llm @resili/llm-anthropic @anthropic-ai/sdk
```

Node.js 20 or newer is required. The official Anthropic TypeScript SDK documents **Node.js 20 LTS or later**.

You supply the Anthropic SDK client. This package does not depend on `@anthropic-ai/sdk` at runtime (optional peer `>=0.20.0`). The adapter is **structural** and was inspected against **`@anthropic-ai/sdk@0.120.0`**. It supports the **Messages API only**. It sets **`maxRetries: 0`** on every SDK call so **Resili owns retries**.

## Relationship to `@resili/llm`

`@resili/llm` owns contracts, pricing, Budget Guard, events, and metrics.

`@resili/llm-anthropic` only:

1. maps `LlmRequest` → Anthropic Messages;
2. maps the message → `LlmResponse` / `LlmUsage`;
3. maps SDK/HTTP failures → `LlmError`;
4. passes Resili's `AbortSignal` into the SDK call with **`maxRetries: 0`**.

## Anthropic client setup

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "@resili/llm-anthropic";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const provider = createAnthropicProvider({
  client: anthropic,
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
});
```

Pass a user-owned client. Do not put keys on `LlmRequest`.

Anthropic requires `max_tokens`. This adapter **does not invent a default**. You must set `maxTokens` on `createAnthropicProvider()`.

## Basic usage

```ts
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createAnthropicProvider } from "@resili/llm-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const llm = createLlmClient({
  provider: createAnthropicProvider({
    client: new Anthropic(),
    model: "claude-sonnet-4-5",
    maxTokens: 1024,
  }),
  model: "claude-sonnet-4-5",
  timeout: { perAttemptMs: 10_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  // Example configuration only — not Anthropic's live price list.
  pricing: createPricingResolver([
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputPerMillionTokensUsd: 3,
      outputPerMillionTokensUsd: 15,
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

`llm.stream()` uses Messages `stream: true` on the raw event iterable (not `messages.stream()` helpers). `maxRetries` remains `0`. `timeout.perAttemptMs` is the full stream attempt including consumer pull wait. Retry only before the first yielded non-empty text.

See `examples/llm-anthropic/stream.mjs`.

## Retry ownership

The official Anthropic Node SDK retries **2 times by default** (connection errors, 408, 409, 429, and 5xx).

This adapter sets **`maxRetries: 0` on every Messages call** so Resili remains the only retry engine when you use `createLlmClient({ retry })`.

If you need SDK-side retries, do not combine them with Resili retry, or you will multiply attempts.

## Timeout and cancellation

Resili's timeout policy aborts `ctx.signal`. The adapter passes that signal to `messages.create(..., { signal })`.

User `AbortSignal` on `generate({ signal })` is composed by `@resili/core` into the same context signal.

## Budget Guard and pricing

Budget Guard and pricing live in `@resili/llm`. This adapter only returns normalized usage.

Flow:

```text
estimate → Budget Guard → Anthropic Messages → actual usage → actual cost → accounting
```

Do not hard-code vendor prices here. Example USD amounts in this README are **illustrative**.

Cache and thinking token counts, when present, are copied to `usage.dimensions` and are **not** priced by the current `@resili/llm` cost calculator.

## Error normalization

| Anthropic / HTTP                     | `LlmError.classification` | Retryable |
| ------------------------------------ | ------------------------- | --------- |
| 401 / `AuthenticationError`          | `authentication`          | no        |
| 403 / `PermissionDeniedError`        | `authorization`           | no        |
| 400 / 402 / 404 / 422                | `invalid_request`         | no        |
| 413 / `request_too_large`            | `context_limit_exceeded`  | no        |
| 429 / `RateLimitError`               | `rate_limited`            | yes       |
| 408 / `APIConnectionTimeoutError`    | `timeout`                 | yes       |
| `APIConnectionError` / network codes | `network_transient`       | yes       |
| 409 / `ConflictError`                | `network_transient`       | yes       |
| 529 / `overloaded_error` / 503       | `overloaded`              | yes       |
| 5xx                                  | `provider_unavailable`    | yes       |
| other                                | `unknown`                 | no        |

`cause` is a sanitized snapshot (`status`, `type`, `requestID`). It does not include headers, bodies, prompts, or API keys.

## Security and privacy

- No default logging.
- Events and metrics come from `@resili/llm` and do not include prompts or completions.
- Normalized error messages are classification text only.
- API keys remain owned by the application.

## Alpha limitations

- Messages API only (no tools, vision, embeddings, batches, or beta APIs). Unary `generate()` and pull-through `stream()` are supported.
- Single user message from `LlmRequest.input`
- `maxTokens` must be set by the caller (no silent default)
- Text blocks only; other content blocks are ignored
- Missing Anthropic `usage` becomes zero counts

## License

MIT
