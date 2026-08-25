# `@resili/llm-anthropic`

Maps the Anthropic SDK's Messages API to the `@resili/llm` provider contract.

```text
@resili/llm → @resili/llm-anthropic → @anthropic-ai/sdk
```

Current version: **`0.1.0-alpha.4`**. Provider name: `"anthropic"`.

## Installation

```bash
npm install @resili/core@alpha @resili/llm@alpha @resili/llm-anthropic@alpha @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is an **optional peer dependency** (`>=0.20.0`), so your package manager will not
install it for you. The adapter works against the SDK's shape rather than importing it as a runtime
dependency, which keeps the version under your control.

## Caller-owned client

You construct the SDK client. **Resili never constructs a client and never reads `apiKey` or any
environment variable.**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "@resili/llm-anthropic";

const provider = createAnthropicProvider({
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: "claude-sonnet-4-20250514",
  maxTokens: 1_024,
});
```

```ts
interface CreateAnthropicProviderOptions {
  readonly client: AnthropicClient;
  readonly model?: string;
  readonly maxTokens: number;
}
```

## `maxTokens` is required

Unlike the other two adapters, this one requires `maxTokens` — a positive integer, validated at
construction.

The Messages API requires `max_tokens` on every request and Resili **does not invent a default**. A
made-up value would silently truncate long completions (or, if generous, silently allow expensive
ones), and neither failure mode is acceptable in a cost-sensitive path. Choosing it is your decision.

It doubles as the most reliable cost control available: it is a hard ceiling on output tokens, which
[`maxCostPerRequestUsd`](../llm/budget-guard.md) is not. Truncation surfaces cleanly as
`finishReason: "length"`.

## Requests

**Unary:**

```ts
client.messages.create(
  { model, max_tokens: maxTokens, messages: [{ role: "user", content: request.input }] },
  { signal: ctx.signal, maxRetries: 0 },
);
```

**Streaming:**

```ts
client.messages.create(
  {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: request.input }],
    stream: true,
  },
  { signal: ctx.signal, maxRetries: 0 },
);
```

Streaming uses `messages.create` with `stream: true` — not the SDK's `messages.stream()` helper, whose
accumulation and event abstractions would conflict with Resili's
[pull-through model](../llm/streaming.md#pull-through-execution).

The prompt becomes a single `user` message. No system prompt, message history, or tool definitions in
this alpha.

## Resili owns retries

```ts
import { ANTHROPIC_SDK_MAX_RETRIES } from "@resili/llm-anthropic";

ANTHROPIC_SDK_MAX_RETRIES; // 0
```

`maxRetries: 0` on every request. The SDK retries by default, which would nest a second retry loop
inside each Resili attempt — multiplying calls, hiding delays from Resili, undercounting circuit
breaker failures, and leaving the budget reservation short.

Do not re-enable SDK retries on the client you inject. See [Retries](../llm/retries.md).

## Cancellation

`ctx.signal` is passed as the request-options `signal` for both unary and streaming calls.

`AbortError` and `APIUserAbortError` are **rethrown unchanged** rather than converted to an
`LlmError`, so a cancellation is never miscounted as a provider failure. See
[Cancellation](../llm/cancellation.md).

## Streaming events

Anthropic streams a structured event sequence. The adapter reads:

| Event                 | What it contributes                                              |
| --------------------- | ---------------------------------------------------------------- |
| `message_start`       | Initial usage — typically `input_tokens` with `output_tokens: 0` |
| `content_block_delta` | Text deltas                                                      |
| `message_delta`       | Updated `output_tokens` and the final `stop_reason`              |

### Partial usage merging

Usage arrives in pieces, and the merge is additive-by-key rather than replacing the whole object: **a
later frame that omits a count does not zero an earlier one.**

```text
message_start  → { input_tokens: 8, output_tokens: 0 }
message_delta  → { output_tokens: 42 }          ← no input_tokens
completed      → { inputTokens: 8, outputTokens: 42, totalTokens: 50 }
```

Without that property, the `input_tokens` from `message_start` would be lost the moment a
`message_delta` arrived, and every streamed call would under-report input cost.

## Usage mapping

| Normalized                            | Anthropic field                               |
| ------------------------------------- | --------------------------------------------- |
| `inputTokens`                         | `usage.input_tokens`                          |
| `outputTokens`                        | `usage.output_tokens`                         |
| `totalTokens`                         | _derived_ (`input + output`)                  |
| `dimensions.cacheCreationInputTokens` | `usage.cache_creation_input_tokens`           |
| `dimensions.cacheReadInputTokens`     | `usage.cache_read_input_tokens`               |
| `dimensions.thinkingTokens`           | `usage.output_tokens_details.thinking_tokens` |

The Messages API reports no total, so it is derived. Cache and thinking counts are recorded but **not
priced** — Anthropic bills cache writes at a premium and cache reads at a steep discount, so a
prompt-caching workload will see Resili's cost diverge from the invoice. See
[Usage](../llm/usage.md).

## Finish reasons

| Anthropic `stop_reason`                       | Normalized       |
| --------------------------------------------- | ---------------- |
| `end_turn`, `stop_sequence`                   | `stop`           |
| `max_tokens`, `model_context_window_exceeded` | `length`         |
| `tool_use`                                    | `tool_calls`     |
| `refusal`                                     | `content_filter` |
| anything else (including `pause_turn`)        | `unknown`        |

## Error mapping

| Condition                                                                    | Classification           |
| ---------------------------------------------------------------------------- | ------------------------ |
| `overloaded_error` or **529**                                                | `overloaded`             |
| `timeout_error`, `APIConnectionTimeoutError`, 408                            | `timeout`                |
| `authentication_error`, `AuthenticationError`, 401                           | `authentication`         |
| `permission_error`, `PermissionDeniedError`, 403                             | `authorization`          |
| `rate_limit_error`, `RateLimitError`, 429                                    | `rate_limited`           |
| `APIConnectionError`, network error codes                                    | `network_transient`      |
| `request_too_large` or **413**                                               | `context_limit_exceeded` |
| `ConflictError` or **409**                                                   | `network_transient`      |
| 503 / 529                                                                    | `overloaded`             |
| `InternalServerError`, other 5xx, `api_error`                                | `provider_unavailable`   |
| `invalid_request_error`, `not_found_error`, `billing_error`, 400/402/404/422 | `invalid_request`        |
| anything else                                                                | `unknown`                |

Two Anthropic-specific points worth knowing. **529** is Anthropic's own overload status and maps to
`overloaded` (retryable) rather than falling through to a generic 5xx. And **409** maps to
`network_transient`, making it retryable — a deliberate divergence from a strict HTTP reading of
"conflict".

Error types are read from a nested `error.error.type` as well as a top-level `error.type`, and the
status from either `status` or `statusCode`. The `cause` carries `name`, `status`, `type`, and
`requestID`.

**Mid-stream errors use the same mapping.** See [Errors](../llm/errors.md).

## Content blocks

Anthropic returns an array of content blocks. The adapter concatenates the `text` of every
`type: "text"` block, in order, with no separator. Blocks of other types — `tool_use`, `thinking`,
images — are **skipped**.

```text
[ {text "Hello"}, {tool_use …}, {text " world"} ]  →  "Hello world"
```

So a response consisting solely of a `tool_use` block yields empty content with
`finishReason: "tool_calls"`. Check the finish reason before assuming content is meaningful.

## Example

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, createPricingResolver, isLlmError } from "@resili/llm";
import { createAnthropicProvider } from "@resili/llm-anthropic";

const llm = createLlmClient({
  provider: createAnthropicProvider({
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    maxTokens: 2_048,
  }),
  model: "claude-sonnet-4-20250514",
  timeout: { perAttemptMs: 90_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  pricing: createPricingResolver([
    {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputPerMillionTokensUsd: 3,
      outputPerMillionTokensUsd: 15,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.2, maxAccumulatedCostUsd: 100 },
});

const result = await llm.generate({
  input: "Explain the difference between a bulkhead and a rate limiter.",
  estimatedInputTokens: 25,
  estimatedOutputTokens: 300,
});

if (result.response.finishReason === "length") {
  console.warn("truncated by max_tokens");
}
console.log(result.response.content);

const stream = llm.stream({ input: "Now explain hedged requests." });
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

Runnable versions: [`examples/llm-anthropic`](../../examples/llm-anthropic/README.md).

## Limitations

- Messages API only; no Completions, batch, or files API.
- `maxTokens` is required, with no default.
- Text in, text out. No tools, vision, or system prompts.
- Single `user` message — no conversation history.
- Text content blocks only; `tool_use` and `thinking` blocks are skipped.
- `totalTokens` is derived, not provider-reported.
- Cache and thinking token dimensions recorded but not priced.
- The raw SDK message object is not attached to the result.
- The SDK's `messages.stream()` helper is not used.
