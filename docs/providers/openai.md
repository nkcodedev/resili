# `@resili/llm-openai`

Maps the OpenAI SDK to the `@resili/llm` provider contract.

```text
@resili/llm → @resili/llm-openai → openai SDK
```

Current version: **`0.1.0-alpha.4`**. Provider name: `"openai"`.

## Installation

```bash
npm install @resili/core @resili/llm @resili/llm-openai openai
```

`openai` is an **optional peer dependency** (`>=4.0.0`), so your package manager will not install it
for you. The adapter never imports it as a runtime dependency — it works against the SDK's shape,
which is what lets you control the version.

## Caller-owned client

You construct the SDK client. **Resili never constructs a client and never reads `apiKey` or any
environment variable.** Credentials stay in code you own.

```ts
import OpenAI from "openai";
import { createOpenAiProvider } from "@resili/llm-openai";

const provider = createOpenAiProvider({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4.1-mini",
});
```

```ts
interface CreateOpenAiProviderOptions {
  readonly client: OpenAiClient;
  readonly model?: string;
}
```

Only `client` is required. `model` is the fallback when a request omits one.

Because the client is yours, its `baseURL`, `organization`, `project`, `defaultHeaders`, and custom
`fetch` all apply — which is how you point the adapter at Azure OpenAI or a compatible gateway.

## Chat Completions only

The adapter implements **Chat Completions** (`client.chat.completions.create`) for both unary and
streaming calls.

The **Responses API is not implemented**. It is deferred, not planned-and-documented-as-shipped. Also
absent: Assistants, embeddings, images, audio, moderation, and batch.

## Requests

**Unary:**

```ts
client.chat.completions.create(
  { model, messages: [{ role: "user", content: request.input }] },
  { signal: ctx.signal, maxRetries: 0 },
);
```

**Streaming:**

```ts
client.chat.completions.create(
  {
    model,
    messages: [{ role: "user", content: request.input }],
    stream: true,
    stream_options: { include_usage: true },
  },
  { signal: ctx.signal, maxRetries: 0 },
);
```

`stream_options: { include_usage: true }` is always sent — without it the SDK omits usage from a
stream, and there would be no authoritative token counts for cost or budget settlement.

The prompt becomes a single `user` message. There is no system prompt, no message history, and no
tool definition in this alpha.

## Resili owns retries

```ts
import { OPENAI_SDK_MAX_RETRIES } from "@resili/llm-openai";

OPENAI_SDK_MAX_RETRIES; // 0
```

`maxRetries: 0` is passed on every request. The SDK defaults to 2, which would mean two silent
retries inside each Resili attempt — nine calls for `maxAttempts: 3`, with delays Resili cannot see,
a circuit breaker undercounting failures, and a budget reservation covering a fraction of real spend.

Do not re-enable SDK retries on the client you inject. See [Retries](../llm/retries.md).

## Cancellation

`ctx.signal` is passed as the request-options `signal` for both unary and streaming calls, so
cancellation and per-attempt timeouts close the HTTP connection rather than merely abandoning a
promise.

`AbortError` and `APIUserAbortError` are **rethrown unchanged** rather than converted to an
`LlmError`, so a cancellation is never miscounted as a provider failure. See
[Cancellation](../llm/cancellation.md).

## Usage mapping

| Normalized                   | OpenAI field                                       |
| ---------------------------- | -------------------------------------------------- |
| `inputTokens`                | `usage.prompt_tokens`                              |
| `outputTokens`               | `usage.completion_tokens`                          |
| `totalTokens`                | `usage.total_tokens`                               |
| `dimensions.cachedTokens`    | `usage.prompt_tokens_details.cached_tokens`        |
| `dimensions.reasoningTokens` | `usage.completion_tokens_details.reasoning_tokens` |

Missing or null usage normalizes to zeros. In a stream, a later frame that omits a count does not zero
an earlier one.

`cachedTokens` and `reasoningTokens` are recorded but **not priced** — OpenAI bills cached input at a
discount and reasoning tokens as output, so Resili's cost will diverge where those are significant. See
[Usage](../llm/usage.md).

## Finish reasons

| OpenAI                        | Normalized       |
| ----------------------------- | ---------------- |
| `stop`                        | `stop`           |
| `length`                      | `length`         |
| `content_filter`              | `content_filter` |
| `tool_calls`, `function_call` | `tool_calls`     |
| anything else                 | `unknown`        |

`length` means the response was truncated by a token limit — the call succeeded but the content is
incomplete.

## Error mapping

| Condition                                                                   | Classification           |
| --------------------------------------------------------------------------- | ------------------------ |
| `context_length_exceeded` (code or type)                                    | `context_limit_exceeded` |
| `content_filter`, `content_policy_violation`                                | `content_policy`         |
| `AuthenticationError` / 401                                                 | `authentication`         |
| `PermissionDeniedError` / 403                                               | `authorization`          |
| `RateLimitError` / 429                                                      | `rate_limited`           |
| `APIConnectionTimeoutError`, `TimeoutError`                                 | `timeout`                |
| `APIConnectionError`, `ECONNRESET`/`ECONNREFUSED`/`ENOTFOUND`/`EPIPE`       | `network_transient`      |
| 503                                                                         | `overloaded`             |
| `InternalServerError` / other 5xx                                           | `provider_unavailable`   |
| `BadRequestError`, `NotFoundError`, `UnprocessableEntityError`, 400/404/422 | `invalid_request`        |
| anything else                                                               | `unknown`                |

A `retry-after` header is converted to `LlmError.retryAfterMs`, which the retry policy uses as the
delay when `respectRetryAfter` is enabled — better than guessing with exponential backoff.

The `cause` carries a redacted summary: `name`, `status`, `code`, `type`, and `requestID`. Log
`requestID`; it is what OpenAI support will ask for.

**Mid-stream errors use the same mapping.** See [Errors](../llm/errors.md).

## First choice only

The adapter reads `choices[0]` — its `message.content` for unary calls and `delta.content` for
streaming. Additional choices from `n > 1` are ignored, and non-string content is treated as empty.

The model identity is `completion.model` when the SDK reports one, otherwise the requested model. The
reported value is often a dated snapshot (`gpt-4.1-mini-2025-04-14`), and _that_ is the key your
[pricing](../llm/pricing.md) table needs a row for.

## Example

```ts
import OpenAI from "openai";
import { createLlmClient, createPricingResolver, isLlmError } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 60_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
    {
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.05, maxAccumulatedCostUsd: 50 },
});

// Unary
const result = await llm.generate({
  input: "Explain the bulkhead pattern in two sentences.",
  estimatedInputTokens: 20,
  estimatedOutputTokens: 120,
});
console.log(result.response.content, result.usage.totalTokens, result.cost?.totalCostUsd);

// Streaming
const stream = llm.stream({ input: "Explain pull-through streaming." });
try {
  for await (const event of stream) {
    if (event.type === "text-delta") process.stdout.write(event.text);
    if (event.type === "completed") console.log("\n", event.usage.totalTokens);
  }
} catch (error) {
  if (isLlmError(error)) console.error(error.classification, error.retryable);
}

await llm.destroy();
```

Runnable versions: [`examples/llm-openai`](../../examples/llm-openai/README.md).

## Azure OpenAI and compatible gateways

Not explicitly supported, but not blocked either — the adapter uses whatever client you inject, so any
client exposing `chat.completions.create` works:

```ts
const provider = createOpenAiProvider({
  client: new OpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseURL: "https://your-resource.openai.azure.com/openai/deployments/your-deployment",
    defaultQuery: { "api-version": "2024-10-21" },
    defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
  }),
});
```

`response.provider` is still `"openai"`, so price rows use that provider name.

## Limitations

- Chat Completions only; the **Responses API is deferred**.
- Text in, text out. No tools, structured output, JSON schema, vision, or audio.
- Single `user` message — no system prompt or conversation history.
- `choices[0]` only.
- `cachedTokens` and `reasoningTokens` recorded but not priced.
- The raw SDK response object is not attached to the result.
- A `ConfigurationError` is raised if a unary call returns a stream, or a stream call returns a unary
  completion.
