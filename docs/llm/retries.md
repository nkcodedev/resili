# LLM retries

Retry behavior comes from core's [retry policy](../core/retry.md); what is LLM-specific is _what
counts as retryable_ and _when retrying is safe_.

## Resili owns retries

Every official adapter disables the SDK's retry loop — `maxRetries: 0` for OpenAI and Anthropic,
`retryOptions.attempts: 1` for Gemini.

If both layers retried, three SDK retries inside three Resili attempts would be nine provider calls,
with delays Resili cannot see, a circuit breaker that counts one failure instead of nine, and a budget
reservation covering a fraction of the real spend. One owner keeps retry composable with the timeout,
the breaker, the classifier, and the budget.

If you write your own adapter, disable your SDK's retries too.

## What is retryable

`llmClassifier` decides, based on the `LlmError.classification` an adapter assigned.

| Classification           | Retryable | Rationale                                  |
| ------------------------ | --------- | ------------------------------------------ |
| `rate_limited`           | **Yes**   | Transient; usually carries a `Retry-After` |
| `timeout`                | **Yes**   | Transient (pre-commit only for streams)    |
| `provider_unavailable`   | **Yes**   | 5xx                                        |
| `overloaded`             | **Yes**   | Provider is shedding load                  |
| `network_transient`      | **Yes**   | Connection reset, DNS failure              |
| `authentication`         | No        | A bad key stays bad                        |
| `authorization`          | No        | Permission will not appear on retry        |
| `invalid_request`        | No        | The request is malformed                   |
| `context_limit_exceeded` | No        | The prompt is too long; shorten it         |
| `content_policy`         | No        | Deterministic refusal                      |
| `budget`                 | No        | Your own limit                             |
| `unknown`                | No        | Fail closed rather than retrying blindly   |

Core's `TimeoutError` is also retryable — subject to the streaming commit point below. Cancellations
are never retryable.

`unknown` deliberately does not retry. An unrecognized error might be a transient blip or a permanent
misconfiguration, and retrying an unbounded unknown risks amplifying an outage.

## Configuration

```ts
const llm = createLlmClient({
  provider,
  retry: {
    maxAttempts: 3,
    backoff: "exponential",
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    maxTotalDelayMs: 60_000,
    jitter: "none",
    respectRetryAfter: true,
  },
  timeout: { perAttemptMs: 60_000 },
});
```

LLM calls are slower and more expensive than HTTP calls, which shifts the sensible defaults: prefer a
larger `baseDelayMs` (hundreds of milliseconds, not tens) and a small `maxAttempts`. Three attempts at
60 seconds each is already a three-minute worst case, and each attempt is billable.

### Honoring `Retry-After`

When a provider returns a retry-after hint the adapter puts it on `LlmError.retryAfterMs`, and
`respectRetryAfter` (enabled by default) uses that value as the delay instead of the exponential
curve, clamped to `maxDelayMs`.

This is the single most valuable retry setting against a rate-limited API: the provider is telling you
exactly how long to wait, and guessing with exponential backoff is strictly worse.

### Custom classification

```ts
import { llmClassifier } from "@resili/llm";

const llm = createLlmClient({
  provider,
  classifier: {
    ...llmClassifier,
    isRetryable(outcome, ctx) {
      if (outcome.status === "error" && isLlmError(outcome.error)) {
        if (outcome.error.classification === "unknown") return false;
      }
      return llmClassifier.isRetryable(outcome, ctx);
    },
  },
  retry: { maxAttempts: 3, jitter: "none" },
});
```

A custom classifier is wrapped by the stream commit guard, so it can loosen pre-commit behavior but
cannot re-enable post-commit retries. See below.

## Unary retries

Straightforward: an attempt either produced a complete response or it did not, so retrying is always
safe from a correctness standpoint. Exhausted attempts surface as `RetryExceededError` with the final
`LlmError` on `lastError`.

```ts
try {
  await llm.generate({ input: prompt });
} catch (error) {
  if (error instanceof RetryExceededError && isLlmError(error.lastError)) {
    console.error("gave up:", error.lastError.classification, error.attempts);
  }
}
```

## Streaming retries and the commit point

Streaming cannot retry unconditionally, because a retry after partial output would concatenate two
generations into one corrupt answer. Resili therefore splits a stream's lifetime at the **commit
point**: the moment the first non-empty text delta is delivered to the consumer.

| Phase             | Behavior                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| **Before commit** | Retries normally. Nothing has been shown, so a fresh generation is safe. |
| **After commit**  | **Never** retries — any failure, including a per-attempt timeout.        |

Metadata frames and empty text do not commit, so a provider that sends model identity before its first
token still gets pre-commit retry protection.

Enforcement is a classifier wrapper that returns `false` for `isRetryable` once committed, which is
why it also overrides a custom always-retry classifier. Full detail in
[Streaming](streaming.md#the-commit-point).

### Terminal errors differ by phase

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";
import { isLlmError } from "@resili/llm";

try {
  for await (const event of stream) {
    /* … */
  }
} catch (error) {
  // Post-commit timeout: normalized, non-retryable
  if (isLlmError(error) && error.classification === "timeout") {
    // partial output was delivered
  }

  // Pre-commit exhaustion: still a core RetryExceededError
  if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    // nothing was shown to the user
  }
}
```

That asymmetry is intentional. Pre-commit failures are ordinary retry exhaustion and keep core's
error shape. A post-commit timeout is normalized to a non-retryable `LlmError("timeout")` so the
non-retryability is explicit at the public boundary — in the iterator, from `result()`, and on
`LlmStreamFailed` with `committed: true`.

### Version note

In `@resili/llm` `0.1.0-alpha.3`, a per-attempt timeout after committed text was still classified
retryable, so `retry.maxAttempts > 1` could start additional generations and duplicate visible text.
Fixed in `0.1.0-alpha.4`.

## Interaction with other policies

- **Circuit breaker** sits inside retry. `authentication` and `invalid_request` failures are not
  retryable, so they end the loop on the first attempt.
- **Budget Guard** sits _outside_ retry at `{ before: "retry" }`, so one reservation covers all
  attempts. But note that each retry is a real billable call, so `maxAttempts: 3` can cost roughly
  three times the estimate. See [Budget Guard](budget-guard.md).
- **Timeout** sits inside retry, so each attempt gets a fresh `perAttemptMs`.
- **Fallback** is outermost and sees `RetryExceededError` after the loop gives up — a natural place to
  fall back to a cheaper model.

## Observability

```ts
llm.onCore("RetryStarted", (event) => {
  console.log(`retry ${event.attemptNumber} in ${event.delayMs}ms`, event.reason);
});
llm.onCore("RetryFailed", (event) => {
  console.error(`exhausted after ${event.attempts}`, event.lastErrorCode);
});
llm.on("LlmStreamFailed", (event) => {
  if (event.committed) console.error("post-commit failure", event.classification);
});
```

Retry events are on `onCore`; LLM lifecycle events on `on`.

## Recommendations

- Keep `maxAttempts` at 2–3. Each attempt is a full billable generation.
- Leave `respectRetryAfter` enabled.
- Use `jitter: "none"` — it is the only implemented mode.
- Pair retry with a circuit breaker so a provider outage fails fast instead of retrying every request.
- Upgrade to `0.1.0-alpha.4` or later before combining streaming with retries.
