# `@resili/llm-gemini`

Maps Google's `@google/genai` SDK to the `@resili/llm` provider contract.

```text
@resili/llm → @resili/llm-gemini → @google/genai
```

Current version: **`0.1.0-alpha.3`** — one behind the other LLM packages, which are at
`0.1.0-alpha.4`. It is the current release for this package. Provider name: `"gemini"`.

## SDK: `@google/genai`, not the legacy SDK

This adapter targets **`@google/genai`** (`>=1.0.0`), Google's current unified SDK.

It does **not** support the legacy `@google/generative-ai` package, which Google has deprecated. The
two have different client classes, method names, and configuration shapes, so the legacy package will
not work here. If you are migrating, replace `GoogleGenerativeAI` with `GoogleGenAI` and call
`client.models.*` rather than `getGenerativeModel()`.

## Installation

```bash
npm install @resili/core @resili/llm @resili/llm-gemini @google/genai
```

`@google/genai` is an **optional peer dependency**, so your package manager will not install it for
you.

## Caller-owned client

You construct the `GoogleGenAI` client. **Resili never constructs a client and never reads an API key
or any environment variable.**

```ts
import { GoogleGenAI } from "@google/genai";
import { createGeminiProvider } from "@resili/llm-gemini";

const provider = createGeminiProvider({
  client: new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }),
  model: "gemini-2.5-flash",
});
```

```ts
interface CreateGeminiProviderOptions {
  readonly client: GeminiClient;
  readonly model?: string;
}
```

Only `client` is required.

Because the client is yours, Vertex AI configuration is entirely up to you — the adapter contains no
Vertex-specific logic and neither enables nor rejects it. A client configured with `vertexai: true`
and a project/location will be used as given; `response.provider` is still `"gemini"`.

## Requests

**Unary** — `client.models.generateContent`:

```ts
client.models.generateContent({
  model,
  contents: request.input,
  config: {
    abortSignal: ctx.signal,
    httpOptions: { retryOptions: { attempts: 1 } },
  },
});
```

**Streaming** — `client.models.generateContentStream`, with the identical parameter shape.

Note that `contents` is a plain **string**, not a structured `Content[]` array: one text turn, no
system instruction, no history, no tool declarations.

Streaming requires `client.models.generateContentStream` to exist on the injected client; a
`ConfigurationError` is raised if it does not.

## Resili owns retries

```ts
import { GEMINI_SDK_HTTP_ATTEMPTS } from "@resili/llm-gemini";

GEMINI_SDK_HTTP_ATTEMPTS; // 1
```

Gemini expresses retries as a **total attempt count** rather than a retry count, so `attempts: 1`
means "one attempt, no retries" — the equivalent of `maxRetries: 0` elsewhere. The SDK default is
`5`, which without this would mean up to five silent HTTP attempts inside every Resili attempt.

It is set via `config.httpOptions.retryOptions.attempts` on every unary and streaming call. Do not
raise it on the client you inject. See [Retries](../llm/retries.md).

## Cancellation

Gemini takes the signal at **`config.abortSignal`**, not a top-level `signal` field — a difference
from the OpenAI and Anthropic adapters that matters only if you are writing your own.

Recognized as cancellation and **rethrown unchanged**: `AbortError`, `DOMException`, and HTTP status
**499**. Gemini's use of 499 for client-closed-request is why the abort check is broader here. See
[Cancellation](../llm/cancellation.md).

## Cumulative snapshot de-duplication

The behavior most specific to this adapter.

`generateContentStream` may emit **cumulative snapshots** rather than incremental deltas — each chunk
containing the full text so far, not just what is new. Passing those through verbatim would show the
user the whole answer repeatedly:

```text
chunk 1 → "Hello"
chunk 2 → "Hello world"
chunk 3 → "Hello world again"

naive output: "HelloHello worldHello world again"
```

The adapter tracks what it has already emitted and yields only the new suffix. The rule, given
`previous` (already emitted) and `incoming` (this chunk's full visible text):

| Case                              | Emitted           | Example                                 |
| --------------------------------- | ----------------- | --------------------------------------- |
| `incoming` is empty               | nothing           | `("Hello", "")` → `""`                  |
| `incoming` starts with `previous` | the suffix only   | `("Hello", "Hello world")` → `" world"` |
| `previous` starts with `incoming` | nothing           | `("Hello world", "Hello")` → `""`       |
| neither is a prefix of the other  | all of `incoming` | `("Hel", "lo")` → `"lo"`                |

The third case guards against a shrinking snapshot producing a duplicate or a negative delta. The
fourth is the fallback for genuinely incremental deltas, which pass through unchanged — so the same
logic handles both streaming styles without configuration.

Empty deltas are never yielded, which also means a de-duplicated chunk cannot accidentally
[commit the stream](../llm/streaming.md#the-commit-point).

## Usage mapping

| Normalized                           | Gemini field                            |
| ------------------------------------ | --------------------------------------- |
| `inputTokens`                        | `usageMetadata.promptTokenCount`        |
| `outputTokens`                       | `usageMetadata.candidatesTokenCount`    |
| `totalTokens`                        | `usageMetadata.totalTokenCount`         |
| `dimensions.cachedContentTokenCount` | `usageMetadata.cachedContentTokenCount` |
| `dimensions.thoughtsTokenCount`      | `usageMetadata.thoughtsTokenCount`      |
| `dimensions.toolUsePromptTokenCount` | `usageMetadata.toolUsePromptTokenCount` |

Missing `usageMetadata` normalizes to zeros. In a stream, a later frame that omits a count does not
zero an earlier one.

`thoughtsTokenCount` is the one to watch on thinking-enabled models: Google bills thinking tokens, but
they are recorded under `dimensions` and **not priced**, so Resili's cost will understate the invoice.
See [Usage](../llm/usage.md).

## Finish reasons

| Gemini                                                                                                        | Normalized       |
| ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `STOP`                                                                                                        | `stop`           |
| `MAX_TOKENS`                                                                                                  | `length`         |
| `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT` | `content_filter` |
| `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`                                                             | `tool_calls`     |
| anything else                                                                                                 | `unknown`        |

### Blocked prompts

Gemini can reject a prompt before generating anything, returning `promptFeedback.blockReason` with no
candidates. The adapter treats that as `content_filter` with empty content — a successful call whose
finish reason tells you it was refused, rather than a thrown error.

```ts
const result = await llm.generate({ input: prompt });
if (result.response.finishReason === "content_filter" && result.response.content === "") {
  // prompt was blocked before generation
}
```

## Error mapping

Gemini reports Google API status names as well as HTTP status codes; both are checked.

| Condition                                                               | Classification         |
| ----------------------------------------------------------------------- | ---------------------- |
| `UNAUTHENTICATED`, `AuthenticationError`, 401                           | `authentication`       |
| `PERMISSION_DENIED`, `PermissionDeniedError`, 403                       | `authorization`        |
| `RESOURCE_EXHAUSTED`, `RESOURCE_EXHAUSTED_ERROR`, `RateLimitError`, 429 | `rate_limited`         |
| `DEADLINE_EXCEEDED`, 408, **504**                                       | `timeout`              |
| network error codes                                                     | `network_transient`    |
| `UNAVAILABLE`, 503                                                      | `overloaded`           |
| `InternalServerError`, other 5xx                                        | `provider_unavailable` |
| `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, 400/404/422     | `invalid_request`      |
| anything else                                                           | `unknown`              |

Status names are read from `error.code`, `error.type`, or a nested `error.error.status` /
`error.error.code`. The `cause` carries `name`, `status`, `code`, `type`, and `requestID` (including an
`x-request-id` header when present).

`FAILED_PRECONDITION` frequently means billing is not enabled on the project — it maps to
`invalid_request` and is not retried, which is correct: no amount of retrying will enable billing.

**Mid-stream errors use the same mapping.** See [Errors](../llm/errors.md).

## First candidate only

The adapter reads `candidates[0]`. Additional candidates are ignored.

Within that candidate, the text of every part is concatenated **except** parts marked
`thought: true` — thinking content is excluded from the visible text, which is what you want for
display but means reasoning traces are not accessible. `inlineData` and `functionCall` parts are
skipped as well.

Model identity comes from `response.modelVersion` when non-empty, otherwise the requested model.

## Example

```ts
import { GoogleGenAI } from "@google/genai";
import { createLlmClient, createPricingResolver, isLlmError } from "@resili/llm";
import { createGeminiProvider } from "@resili/llm-gemini";

const llm = createLlmClient({
  provider: createGeminiProvider({
    client: new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }),
  }),
  model: "gemini-2.5-flash",
  timeout: { perAttemptMs: 60_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, jitter: "none" },
  circuitBreaker: { minimumThroughput: 20, failureRateThreshold: 50 },
  pricing: createPricingResolver([
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputPerMillionTokensUsd: 0.3,
      outputPerMillionTokensUsd: 2.5,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.05, maxAccumulatedCostUsd: 50 },
});

const result = await llm.generate({
  input: "Explain the circuit breaker pattern in two sentences.",
  estimatedInputTokens: 20,
  estimatedOutputTokens: 150,
});
console.log(result.response.content, result.usage.dimensions?.thoughtsTokenCount);

// De-duplication is transparent: only new text arrives.
const stream = llm.stream({ input: "Now explain bulkheads." });
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

Runnable versions: [`examples/llm-gemini`](../../examples/llm-gemini/README.md).

## Limitations

- `@google/genai` only; the legacy `@google/generative-ai` SDK is not supported.
- `generateContent` and `generateContentStream` only.
- `contents` is a plain string — no system instruction, history, or tool declarations.
- Text in, text out. No vision, audio, function calling, or structured output.
- `candidates[0]` only.
- Thinking parts are excluded from visible text; `thoughtsTokenCount` is recorded but not priced.
- No Vertex AI-specific handling — configure it on the client you inject.
- The raw SDK response object is not attached to the result.
