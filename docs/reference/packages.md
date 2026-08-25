# Package reference

Eight packages, two version lines, all currently on the npm `alpha` dist-tag.

## Matrix

| Package                 | Purpose                                                         | Version         | Dependencies                  | Optional peers               | Node   | Status |
| ----------------------- | --------------------------------------------------------------- | --------------- | ----------------------------- | ---------------------------- | ------ | ------ |
| `@resili/core`          | Runtime: context, pipeline, 9 policies, events, metrics, errors | `0.2.0-alpha.3` | **none**                      | —                            | `>=20` | Alpha  |
| `@resili/fetch`         | fetch-compatible adapter                                        | `0.2.0-alpha.3` | `@resili/core`                | —                            | `>=20` | Alpha  |
| `@resili/axios`         | axios-compatible adapter (injected implementation)              | `0.2.0-alpha.3` | `@resili/core`                | —                            | `>=20` | Alpha  |
| `@resili/undici`        | undici-compatible adapter (injected implementation)             | `0.2.0-alpha.3` | `@resili/core`                | —                            | `>=20` | Alpha  |
| `@resili/llm`           | LLM foundation: contracts, usage, pricing, budget, telemetry    | `0.1.0-alpha.4` | `@resili/core`                | —                            | `>=20` | Alpha  |
| `@resili/llm-openai`    | OpenAI Chat Completions adapter                                 | `0.1.0-alpha.4` | `@resili/core`, `@resili/llm` | `openai >=4.0.0`             | `>=20` | Alpha  |
| `@resili/llm-anthropic` | Anthropic Messages adapter                                      | `0.1.0-alpha.4` | `@resili/core`, `@resili/llm` | `@anthropic-ai/sdk >=0.20.0` | `>=20` | Alpha  |
| `@resili/llm-gemini`    | Google Gemini adapter (`@google/genai`)                         | `0.1.0-alpha.3` | `@resili/core`, `@resili/llm` | `@google/genai >=1.0.0`      | `>=20` | Alpha  |

Every package ships ESM and CommonJS builds with TypeScript declarations for both.

Note that `@resili/axios` and `@resili/undici` have **no peer dependency** on `axios` or `undici` —
they describe those APIs structurally and take an injected implementation. See
[Package boundaries](../architecture/package-boundaries.md).

## Installation

```bash
# Core only
npm install @resili/core@alpha

# Core + an HTTP adapter
npm install @resili/core@alpha @resili/fetch@alpha

# LLM with OpenAI
npm install @resili/core@alpha @resili/llm@alpha @resili/llm-openai@alpha openai
```

The `@alpha` tag is required — `latest` still points at older builds. See
[Versioning](../releases/versioning.md).

## Version lines

| Line        | Packages                                       | Current         |
| ----------- | ---------------------------------------------- | --------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`  | `0.2.0-alpha.3` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic` | `0.1.0-alpha.4` |
|             | `@resili/llm-gemini`                           | `0.1.0-alpha.3` |

The lines version independently. `@resili/llm-gemini` sitting one patch behind its siblings is
expected: the alpha.4 corrective release republished the packages whose packed dependency range needed
to resolve to `@resili/llm@0.1.0-alpha.4`, and Gemini's own increment landed at `alpha.3`. It is the
current release for that package.

A healthy install has one copy of each:

```bash
npm ls @resili/core @resili/llm
```

## What each package exports

### `@resili/core`

Entry points `resili()` and `createClient()`. Policy factories `retryPolicy`, `timeoutPolicy`,
`circuitBreakerPolicy`, `rateLimiterPolicy`, `bulkheadPolicy`, `cachePolicy`, `fallbackPolicy`,
`dedupePolicy`, `hedgePolicy`. Extension points `definePolicy`, `definePlugin`. Errors `ResiliError`,
`ConfigurationError`, `TimeoutError`, `RetryExceededError`, `CircuitOpenError`,
`RateLimitExceededError`, `BulkheadRejectedError`, `AbortError`, plus `isResiliError`. Contracts
`Context`, `Policy`, `FailureClassifier`, `Clock`, `StateStore`, `MetricsRecorder`, `noopMetrics`,
`httpClassifier`.

Docs: [Core overview](../core/overview.md) · [Policies](../core/policies.md)

### `@resili/fetch`

`createFetch`, plus `CreateFetchOptions`, `FetchImplementation`, `ResilientFetch`.
Docs: [fetch adapter](../http/fetch.md)

### `@resili/axios`

`createAxios`, plus `CreateAxiosOptions`, `AxiosImplementation`, `AxiosRequestConfig`,
`AxiosResponse`, `ResilientAxios`.
Docs: [axios adapter](../http/axios.md)

### `@resili/undici`

`createUndici`, plus `CreateUndiciOptions`, `UndiciImplementation`, `UndiciRequestOptions`,
`UndiciResponse`, `ResilientUndici`.
Docs: [undici adapter](../http/undici.md)

### `@resili/llm`

`createLlmClient`, `defineProvider`, `llmClassifier`. Errors `LlmError`, `LlmBudgetExceededError`,
`isLlmError`, `isLlmErrorRetryable`. Pricing `createPricingResolver`, `calculateCost`,
`usdToMicroUsd`, `microUsdToUsd`, `USD_MICROS`, `TOKENS_PER_MILLION`. Usage `normalizeUsage`. Budget
`createMemoryBudgetAccountant`, `evaluateBudget`. Metrics `LLM_METRIC_NAMES`. Streaming types
`LlmStream`, `LlmStreamEvent`, `LlmStreamTextDelta`, `LlmStreamCompleted`, `LlmStreamResult`.

Docs: [LLM overview](../llm/overview.md)

### Provider adapters

| Package                 | Factory                   | Retry constant                  |
| ----------------------- | ------------------------- | ------------------------------- |
| `@resili/llm-openai`    | `createOpenAiProvider`    | `OPENAI_SDK_MAX_RETRIES = 0`    |
| `@resili/llm-anthropic` | `createAnthropicProvider` | `ANTHROPIC_SDK_MAX_RETRIES = 0` |
| `@resili/llm-gemini`    | `createGeminiProvider`    | `GEMINI_SDK_HTTP_ATTEMPTS = 1`  |

Each also exports its options interface and structural SDK types. Docs:
[OpenAI](../providers/openai.md) · [Anthropic](../providers/anthropic.md) ·
[Gemini](../providers/gemini.md)

## Choosing packages

| You want to                                  | Install                                   |
| -------------------------------------------- | ----------------------------------------- |
| Wrap arbitrary async work                    | `@resili/core`                            |
| Harden `fetch` calls                         | `+ @resili/fetch`                         |
| Keep an existing axios instance              | `+ @resili/axios`                         |
| Use undici directly                          | `+ @resili/undici`                        |
| Add resilience and cost control to LLM calls | `+ @resili/llm` and one provider adapter  |
| Support several LLM vendors                  | `+ @resili/llm` and each adapter you need |

## Not yet available

Azure OpenAI and Bedrock adapters, OpenTelemetry and Prometheus plugin packages, distributed state
adapters, and framework middleware. See [Alpha status](../releases/alpha-status.md).

Azure OpenAI can be reached today by pointing an injected OpenAI client at your deployment — see
[OpenAI](../providers/openai.md#azure-openai-and-compatible-gateways).
