# @resili/llm-gemini

> Google Gemini `generateContent` adapter for the Resili LLM foundation.

**Public alpha.** This package is a provider adapter for [`@resili/llm`](../llm/README.md). It is **not** a Gemini SDK replacement and not an agent framework.

You create the official `@google/genai` client. Resili never stores API keys and never contacts a Resili service.

## Installation

```bash
pnpm add @resili/core @resili/llm @resili/llm-gemini @google/genai
```

Node.js 20 or newer is required. `@google/genai@2.18.0` documents **Node.js 20 or later** (Node 22+ is required starting with SDK 3.0.0).

You supply the Gemini SDK client. This package does not depend on `@google/genai` at runtime (optional peer `>=1.0.0`). The adapter is **structural** and was inspected against **`@google/genai@2.18.0`**. It supports **`models.generateContent` only** (plain text in / text out). It sets **`httpOptions.retryOptions.attempts` to `1`** on every call so **Resili owns retries**.

## Relationship to `@resili/llm`

`@resili/llm` owns contracts, pricing, Budget Guard, events, and metrics.

`@resili/llm-gemini` only:

1. maps `LlmRequest` → Gemini `generateContent`;
2. maps the response → `LlmResponse` / `LlmUsage`;
3. maps SDK/HTTP failures → `LlmError`;
4. passes Resili's `AbortSignal` as `config.abortSignal` and disables SDK HTTP retries.

## Gemini client setup

```ts
import { GoogleGenAI } from "@google/genai";
import { createGeminiProvider } from "@resili/llm-gemini";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const provider = createGeminiProvider({
  client: ai,
  model: "gemini-2.5-flash",
});
```

Pass a user-owned client. Do not put keys on `LlmRequest`.

This adapter does **not** enable Vertex AI. Use the Gemini Developer API client the caller constructs.

## Basic usage

```ts
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createGeminiProvider } from "@resili/llm-gemini";
import { GoogleGenAI } from "@google/genai";

const llm = createLlmClient({
  provider: createGeminiProvider({
    client: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
    model: "gemini-2.5-flash",
  }),
  model: "gemini-2.5-flash",
  timeout: { perAttemptMs: 10_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  // Example configuration only — not Google's live price list.
  pricing: createPricingResolver([
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
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

## Retry ownership

`@google/genai` retries HTTP calls by default (`HttpRetryOptions.attempts` defaults to **5**, including the original request) using `p-retry` for statuses 408, 429, 500, 502, 503, and 504.

This adapter sets **`retryOptions.attempts: 1`** (`GEMINI_SDK_HTTP_ATTEMPTS`) on every `generateContent` call so Resili remains the only retry engine when you use `createLlmClient({ retry })`.

The SDK documents that `attempts` of `0` or `1` means no retries. There is no `maxRetries` option on this API; do not combine SDK-level `httpOptions.retryOptions` on the client with Resili retry.

## Timeout and cancellation

Resili's timeout policy aborts `ctx.signal`. The adapter passes that signal as `config.abortSignal` (the field name in `@google/genai` `GenerateContentConfig`).

User `AbortSignal` on `generate({ signal })` is composed by `@resili/core` into the same context signal.

## Budget Guard and pricing

Budget Guard and pricing live in `@resili/llm`. This adapter only returns normalized usage.

Flow:

```text
estimate → Budget Guard → generateContent → actual usage → actual cost → accounting
```

Do not hard-code vendor prices here. Example USD amounts in this README are **illustrative**.

Cached, thoughts, and tool-use prompt token counts, when present, are copied to `usage.dimensions` and are **not** priced by the current `@resili/llm` cost calculator.

## Error normalization

| Gemini / HTTP                        | `LlmError.classification` | Retryable |
| ------------------------------------ | ------------------------- | --------- |
| 401 / `UNAUTHENTICATED`              | `authentication`          | no        |
| 403 / `PERMISSION_DENIED`            | `authorization`           | no        |
| 400 / 404 / 422 / `INVALID_ARGUMENT` | `invalid_request`         | no        |
| 429 / `RESOURCE_EXHAUSTED`           | `rate_limited`            | yes       |
| 408 / 504 / `DEADLINE_EXCEEDED`      | `timeout`                 | yes       |
| network codes                        | `network_transient`       | yes       |
| 503 / `UNAVAILABLE`                  | `overloaded`              | yes       |
| other 5xx                            | `provider_unavailable`    | yes       |
| other                                | `unknown`                 | no        |

Abort / 499 is rethrown so Resili owns cancellation. `cause` is a sanitized snapshot (`status`, `code`/`type`, `requestID`). It does not include headers, bodies, prompts, or API keys.

## Security and privacy

- No default logging.
- Events and metrics come from `@resili/llm` and do not include prompts or completions.
- Normalized error messages are classification text only.
- API keys remain owned by the application.

## Alpha limitations

- `models.generateContent` only (no streaming, tools, multimodal input, embeddings, files, grounding, Vertex-specific setup, or Live API)
- Single user text from `LlmRequest.input` (`contents` string)
- Text parts only; thought parts and other part types are ignored
- Missing Gemini `usageMetadata` becomes zero counts
- First candidate only

## License

MIT
