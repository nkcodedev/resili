# `generate()` — unary generation

`generate()` performs one complete generation and resolves with the full response, its usage, and its
cost. It is the simpler of the two call styles and the right default unless you need to show tokens
as they arrive.

## Request

```ts
interface LlmGenerateRequest {
  readonly input: string;
  readonly model?: string;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}
```

| Field                   | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `input`                 | The prompt text. This alpha is text-in, text-out.            |
| `model`                 | Overrides the client's default model for this call.          |
| `estimatedInputTokens`  | Pre-flight estimate used by [Budget Guard](budget-guard.md). |
| `estimatedOutputTokens` | Pre-flight estimate used by Budget Guard.                    |
| `metadata`              | String key/values placed on the execution context.           |
| `signal`                | Caller cancellation, composed with Resili's internal signal. |

The estimate fields are only consulted when a budget is configured; they never influence the request
sent to the provider.

## Result

```ts
interface LlmGenerateResult {
  readonly response: LlmResponse;
  readonly usage: LlmUsage;
  readonly cost?: LlmCost;
}
```

```ts
const result = await llm.generate({ input: "Explain circuit breakers in one sentence." });

result.response.provider; // "openai"
result.response.model; // model the provider actually reported
result.response.content; // generated text
result.response.finishReason; // "stop" | "length" | "tool_calls" | "content_filter" | "unknown"

result.usage.inputTokens;
result.usage.outputTokens;
result.usage.totalTokens;
result.usage.dimensions; // vendor-specific counts, when reported

result.cost?.totalCostMicroUsd; // integer — use for comparisons and budgets
result.cost?.totalCostUsd; // decimal — use for display
```

### Provider and model

`response.provider` is the adapter's own name (`"openai"`, `"anthropic"`, `"gemini"`).
`response.model` is what the provider reported, falling back to the requested model when the SDK does
not echo one. These often differ from what you asked for — request `gpt-4.1-mini` and you may get back
a dated snapshot such as `gpt-4.1-mini-2025-04-14`. Use the returned value for cost attribution and
logging.

### Usage

Always present, always with the three normalized counts. Missing provider counts become `0` rather
than `undefined`, and `totalTokens` is derived as `inputTokens + outputTokens` when the provider does
not report a total. Extra vendor counts — cached tokens, reasoning tokens, thinking tokens — appear
under `dimensions` and are **not** priced. See [Usage](usage.md).

### Cost

`cost` is `undefined` when no `pricing` resolver is configured, or when the resolver has no row for
that provider/model pair. That is deliberate: an unknown price is unknown, not free. See
[Pricing](pricing.md).

### Finish reason

Normalized to `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, or `"unknown"`. Provider
values are mapped by each adapter; an unrecognized value becomes `"unknown"` rather than throwing.

`"length"` is worth checking explicitly — it means the response was truncated by a token limit, so the
content is incomplete even though the call succeeded.

## Errors

Failures throw. Nothing is signalled through the result object.

| Error                    | Meaning                                                   |
| ------------------------ | --------------------------------------------------------- |
| `LlmError`               | A provider failure, with `classification` and `retryable` |
| `LlmBudgetExceededError` | A budget limit blocked the call before the provider ran   |
| `RetryExceededError`     | Retries exhausted; the final failure is on `lastError`    |
| `TimeoutError`           | Per-attempt timeout with no retry configured              |
| `CircuitOpenError`       | Breaker open                                              |
| `ConfigurationError`     | No model resolved, or an invalid client configuration     |
| `AbortError` / SDK abort | Cancellation                                              |

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";
import { isLlmError, LlmBudgetExceededError } from "@resili/llm";

try {
  const result = await llm.generate({ input: prompt });
  return result.response.content;
} catch (error) {
  if (error instanceof LlmBudgetExceededError) {
    return "Budget limit reached.";
  }
  if (error instanceof RetryExceededError) {
    const last = error.lastError;
    if (isLlmError(last)) {
      console.error(last.classification, last.retryAfterMs);
    }
    throw error;
  }
  if (isLlmError(error) && error.classification === "context_limit_exceeded") {
    return "Prompt too long.";
  }
  if (error instanceof TimeoutError) {
    throw error;
  }
  throw error;
}
```

Note that when retry is configured, a retryable failure surfaces as `RetryExceededError` with the
`LlmError` on `lastError` — not as a bare `LlmError`. Check both.

See [Errors](errors.md).

## Retry

Standard core [retry](../core/retry.md), with retryability decided by `llmClassifier`. Retryable by
default: `rate_limited`, `timeout`, `provider_unavailable`, `overloaded`, `network_transient`.
Not retryable: `authentication`, `authorization`, `invalid_request`, `context_limit_exceeded`,
`content_policy`, `budget`, `unknown`.

When a provider reports a `Retry-After`, the adapter puts it on `LlmError.retryAfterMs` and
`respectRetryAfter` (on by default) uses it as the backoff delay instead of the exponential curve —
which is exactly what you want against a rate-limited API.

```ts
retry: {
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: "none",
  respectRetryAfter: true,
}
```

Unary retry is simple because a `generate()` attempt either produced a complete response or it did
not. Streaming needs a commit point for the same reason it is not simple — see
[Retries](retries.md).

## Timeout

`timeout.perAttemptMs` bounds a single attempt and is renewed for each retry. With
`maxAttempts: 3` and `perAttemptMs: 30_000`, worst-case wall clock is roughly 90 seconds plus backoff.

Generation latency varies with output length, so size `perAttemptMs` against your expected completion
size, not against a typical HTTP call. See [Timeouts](timeouts.md).

## Cancellation

Pass a `signal`; it is composed with Resili's internal signal and forwarded to the SDK.

```ts
const controller = new AbortController();
const promise = llm.generate({ input: prompt, signal: controller.signal });
controller.abort();
```

Abort errors are rethrown unchanged by the adapters rather than being converted to an `LlmError`, and
cancellations are never retried. See [Cancellation](cancellation.md).

## Complete example

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, createPricingResolver, isLlmError } from "@resili/llm";
import { createAnthropicProvider } from "@resili/llm-anthropic";

const llm = createLlmClient({
  provider: createAnthropicProvider({
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    maxTokens: 1_024,
  }),
  model: "claude-sonnet-4-20250514",
  timeout: { perAttemptMs: 60_000 },
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
  budget: { maxCostPerRequestUsd: 0.5, maxAccumulatedCostUsd: 100 },
});

llm.on("LlmRequestCompleted", (event) => {
  console.log(event.durationMs, event.totalTokens, event.costMicroUsd);
});

try {
  const result = await llm.generate({
    input: "Summarize the CAP theorem in two sentences.",
    estimatedInputTokens: 20,
    estimatedOutputTokens: 120,
  });

  console.log(result.response.content);

  if (result.response.finishReason === "length") {
    console.warn("truncated by max_tokens");
  }
} catch (error) {
  if (isLlmError(error)) {
    console.error(error.classification, error.retryable);
  }
  throw error;
} finally {
  await llm.destroy();
}
```

## Limitations

- Text in, text out. No tool calls, structured output, vision, or multi-turn message arrays — `input`
  is a single user message.
- One choice/candidate is read; alternatives are ignored.
- `usage.dimensions` is recorded but not priced.
- `maxCostPerRequestUsd` checks the _estimate_, so actual cost can exceed it.
- The raw SDK response object is not attached to the result.
