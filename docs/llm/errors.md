# LLM errors

Provider SDKs each have their own error taxonomy. `@resili/llm` normalizes them into `LlmError` with a
provider-neutral classification, a retryability flag, and the original error preserved as `cause`.

## `LlmError`

```ts
class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly classification: LlmErrorClassification;
  readonly retryable: boolean;
  readonly isResiliLlm: true;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly cause?: unknown;
}
```

| Property            | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `classification`    | Provider-neutral failure kind — the field to branch on                   |
| `retryable`         | Whether Resili's classifier considers this worth retrying                |
| `cause`             | The original SDK error, for vendor-specific detail                       |
| `retryAfterMs`      | Provider-supplied hint, used as the retry delay when `respectRetryAfter` |
| `provider`, `model` | Which provider and model produced it                                     |
| `isResiliLlm`       | Cross-package marker used by `isLlmError`                                |

Use the type guard rather than `instanceof` when errors may cross package boundaries:

```ts
import { isLlmError, isLlmErrorRetryable } from "@resili/llm";

if (isLlmError(error)) {
  console.error(error.classification, error.retryable, error.code);
}
isLlmErrorRetryable(error); // false for anything that is not a retryable LlmError
```

## Classifications

Twelve, all implemented.

| Classification           | Code                      | Retryable | Typical cause                       |
| ------------------------ | ------------------------- | --------- | ----------------------------------- |
| `authentication`         | `ERR_LLM_AUTH`            | No        | Missing or invalid API key (401)    |
| `authorization`          | `ERR_LLM_FORBIDDEN`       | No        | Key lacks access to the model (403) |
| `invalid_request`        | `ERR_LLM_INVALID_REQUEST` | No        | Malformed request (400, 404, 422)   |
| `rate_limited`           | `ERR_LLM_RATE_LIMITED`    | **Yes**   | Quota or rate limit (429)           |
| `timeout`                | `ERR_LLM_TIMEOUT`         | **Yes**\* | Provider or connection timeout      |
| `provider_unavailable`   | `ERR_LLM_UNAVAILABLE`     | **Yes**   | 5xx other than an overload signal   |
| `overloaded`             | `ERR_LLM_OVERLOADED`      | **Yes**   | 503, or Anthropic 529               |
| `context_limit_exceeded` | `ERR_LLM_CONTEXT_LIMIT`   | No        | Prompt exceeds the context window   |
| `content_policy`         | `ERR_LLM_CONTENT_POLICY`  | No        | Safety filter or refusal            |
| `network_transient`      | `ERR_LLM_NETWORK`         | **Yes**   | `ECONNRESET`, `ENOTFOUND`, `EPIPE`  |
| `budget`                 | `ERR_LLM_BUDGET`          | No        | A Resili budget limit               |
| `unknown`                | `ERR_LLM_UNKNOWN`         | No        | Unrecognized error                  |

\* `timeout` is retryable by default, but **not** after a stream commits — see below.

`retryable` can be set explicitly when constructing an `LlmError`; otherwise it is derived from the
classification. `unknown` defaults to non-retryable deliberately: an unrecognized failure could be a
transient blip or a permanent misconfiguration, and retrying it blindly risks amplifying an outage.

## `LlmBudgetExceededError`

```ts
class LlmBudgetExceededError extends LlmError {
  readonly scope: string;
  readonly limitKind: "per-request" | "accumulated" | "unknown-pricing";
  readonly limitMicroUsd: number;
  readonly accumulatedMicroUsd: number;
  readonly attemptedMicroUsd: number;
}
```

Always `classification: "budget"`, `retryable: false`, `code: "ERR_LLM_BUDGET"`. See
[Budget Guard](budget-guard.md).

## Core errors you will also see

`@resili/llm` builds on core, so core's [error hierarchy](../reference/errors.md) surfaces too:

| Error                | When                                                         |
| -------------------- | ------------------------------------------------------------ |
| `RetryExceededError` | Retries exhausted; the final `LlmError` is on `lastError`    |
| `TimeoutError`       | Per-attempt timeout with no retry configured                 |
| `CircuitOpenError`   | Breaker open                                                 |
| `ConfigurationError` | No model resolved, unsupported config, streaming unsupported |
| `AbortError`         | Cancellation                                                 |

The wrapping is the part that catches people out: with retry configured, a retryable failure surfaces
as `RetryExceededError`, **not** as a bare `LlmError`. Check both layers.

```ts
import { RetryExceededError } from "@resili/core";
import { isLlmError } from "@resili/llm";

function classificationOf(error: unknown): string | undefined {
  if (isLlmError(error)) return error.classification;
  if (error instanceof RetryExceededError && isLlmError(error.lastError)) {
    return error.lastError.classification;
  }
  return undefined;
}
```

## Streaming: pre-commit versus post-commit

Streaming timeout errors take two different shapes depending on whether text has been delivered. This
is intentional, not an inconsistency.

| Phase           | Retried         | Terminal error                                                |
| --------------- | --------------- | ------------------------------------------------------------- |
| **Pre-commit**  | Yes, per policy | `RetryExceededError` with `lastError instanceof TimeoutError` |
| **Post-commit** | **No**          | `LlmError`, `classification: "timeout"`, `retryable: false`   |

A pre-commit failure is ordinary retry exhaustion, so it keeps core's error shape — nothing was shown
to the user and the application may safely retry at its own level.

A post-commit timeout is normalized to a non-retryable `LlmError` so that non-retryability is explicit
at every observation point: the iterator, `result()`, and the `LlmStreamFailed` event (with
`committed: true`). Post-commit failures of other kinds are likewise re-wrapped as `LlmError` with
`retryable: false`.

Abort errors pass through unchanged in both phases.

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";
import { isLlmError } from "@resili/llm";

try {
  for await (const event of stream) {
    /* … */
  }
} catch (error) {
  if (isLlmError(error) && error.classification === "timeout" && !error.retryable) {
    // partial output was delivered; do not retry
  } else if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    // nothing was shown; safe to retry
  }
}
```

See [Streaming](streaming.md#the-commit-point).

## Provider mapping

Each adapter translates its SDK's errors. Highlights of what differs:

| Signal                        | OpenAI                                       | Anthropic                     | Gemini                                |
| ----------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------------- |
| 401                           | `authentication`                             | `authentication`              | `authentication` / `UNAUTHENTICATED`  |
| 403                           | `authorization`                              | `authorization`               | `authorization` / `PERMISSION_DENIED` |
| 429                           | `rate_limited`                               | `rate_limited`                | `rate_limited` / `RESOURCE_EXHAUSTED` |
| 503                           | `overloaded`                                 | `overloaded`                  | `overloaded` / `UNAVAILABLE`          |
| Other 5xx                     | `provider_unavailable`                       | `provider_unavailable`        | `provider_unavailable`                |
| Overload-specific             | —                                            | **529**, `overloaded_error`   | —                                     |
| Context limit                 | `context_length_exceeded`                    | **413** / `request_too_large` | —                                     |
| Content policy                | `content_filter`, `content_policy_violation` | `refusal` (finish reason)     | `SAFETY` family (finish reason)       |
| Timeout                       | `APIConnectionTimeoutError`                  | `timeout_error`, **408**      | `DEADLINE_EXCEEDED`, 408, **504**     |
| Conflict (409)                | —                                            | **`network_transient`**       | —                                     |
| Cancellation (passed through) | `AbortError`, `APIUserAbortError`            | same                          | plus `DOMException`, **499**          |

Gemini uses Google API status names (`UNAUTHENTICATED`, `RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`,
`NOT_FOUND`, `FAILED_PRECONDITION`) as well as HTTP status codes. Anthropic mapping a 409 to
`network_transient` — and therefore retryable — is a deliberate divergence from a strict HTTP reading.

Mid-stream errors use the **same** mapping as unary errors in all three adapters.

Per-adapter detail: [OpenAI](../providers/openai.md), [Anthropic](../providers/anthropic.md),
[Gemini](../providers/gemini.md).

## Error causes

The original SDK error is on `cause`, and each adapter attaches a small redacted summary — `name`,
`status`, `code`/`type`, and `requestID` where available. Secret-looking values are redacted, and
prompts and completions never appear in a Resili-generated message.

```ts
if (isLlmError(error)) {
  const cause = error.cause as { status?: number; requestID?: string } | undefined;
  console.error(error.classification, cause?.status, cause?.requestID);
}
```

`requestID` is worth logging: it is what a provider's support team will ask for.

## Handling patterns

Branch on classification, not on status codes:

```ts
import { isLlmError, LlmBudgetExceededError } from "@resili/llm";
import { CircuitOpenError, RetryExceededError } from "@resili/core";

async function ask(prompt: string): Promise<string> {
  try {
    const result = await llm.generate({ input: prompt });
    return result.response.content;
  } catch (error) {
    if (error instanceof LlmBudgetExceededError) {
      return "Usage limit reached for this period.";
    }
    if (error instanceof CircuitOpenError) {
      return "The assistant is temporarily unavailable.";
    }

    const classification = isLlmError(error)
      ? error.classification
      : error instanceof RetryExceededError && isLlmError(error.lastError)
        ? error.lastError.classification
        : "unknown";

    switch (classification) {
      case "context_limit_exceeded":
        return "That request is too long. Please shorten it.";
      case "content_policy":
        return "That request could not be processed.";
      case "authentication":
      case "authorization":
        throw error; // operator problem, not a user problem
      default:
        return "Something went wrong. Please try again.";
    }
  }
}
```

Two things this shape gets right: `authentication` and `authorization` are rethrown rather than shown
as a friendly message, because they are deployment faults that should page someone; and classification
is read through both the direct and the retry-wrapped paths.

Fall back to a cheaper model when a provider is unavailable:

```ts
import { CircuitOpenError, RetryExceededError } from "@resili/core";

fallback: {
  fallbackOn: (error) => error instanceof RetryExceededError || error instanceof CircuitOpenError,
  handler: () => cheapModelClient.generate({ input: prompt }).then((r) => r.response),
}
```

## Observability

```ts
llm.on("LlmRequestFailed", (event) => {
  console.error(event.classification, event.retryable, event.durationMs);
});
llm.on("LlmStreamFailed", (event) => {
  console.error(event.classification, event.retryable, event.committed);
});
```

Both carry `classification` and `retryable`; the stream event adds `committed`. Neither contains
prompts or completions. Metric: `resili_llm_failures_total` / `resili_llm_stream_failures_total`,
labelled `result: "failure"`.

## Limitations

- `unknown` is a real outcome for unmapped errors, and it is not retried.
- Classification granularity is limited to the twelve values above.
- Retry-wrapped errors need double unwrapping.
- `dimensions`-based billing differences are not reflected in any error or cost.
- Abort errors are not `LlmError`s, so `isLlmError` returns `false` for cancellations.
