# Error classification

Resili does not hardcode what counts as a failure. A `FailureClassifier` answers two questions, and
the retry and circuit breaker policies consult it.

```ts
interface FailureClassifier {
  isFailure(outcome: Outcome, ctx: Context): boolean;
  isRetryable(outcome: Outcome, ctx: Context): boolean;
  retryAfter?(outcome: Outcome, ctx: Context): number | undefined;
}
```

## Two independent questions

| Question      | Consumer        | Meaning                                        |
| ------------- | --------------- | ---------------------------------------------- |
| `isFailure`   | Circuit breaker | Does this suggest the dependency is unhealthy? |
| `isRetryable` | Retry           | Is trying again likely to help?                |
| `retryAfter`  | Retry           | Did the outcome tell us how long to wait?      |

They are genuinely independent, and the interesting cases are where they diverge:

| Outcome                  | `isFailure` | `isRetryable` | Why                                                        |
| ------------------------ | ----------- | ------------- | ---------------------------------------------------------- |
| `TimeoutError`           | Yes         | Yes           | The dependency is unhealthy _and_ worth retrying           |
| `RateLimitExceededError` | **No**      | Yes           | Local admission control; the dependency never saw the call |
| `BulkheadRejectedError`  | **No**      | Yes           | Same — local saturation, not remote sickness               |
| `CircuitOpenError`       | **No**      | **No**        | Our own decision; counting it would keep the breaker open  |
| `AbortError`             | **No**      | **No**        | The caller withdrew; nothing failed                        |
| Generic `Error`          | Yes         | **No**        | Something broke, but it may not be transient               |
| HTTP 404                 | **No**      | **No**        | A definite answer                                          |
| HTTP 503                 | Yes         | Yes           | Transient server-side failure                              |

The self-referential cases matter most. If `CircuitOpenError` counted as a failure, a breaker's own
rejections would feed its window and it could never recover. If admission-control rejections counted,
your own backpressure would look like a downstream outage.

## The default: `httpClassifier`

### Successful outcomes

For a returned value with an integer `status`:

| Statuses                | `isFailure` | `isRetryable` |
| ----------------------- | ----------- | ------------- |
| 408, 500, 502, 503, 504 | Yes         | Yes           |
| 429                     | No          | **Yes**       |
| Other 4xx               | No          | No            |
| 2xx / 3xx               | No          | No            |

429 is retryable but not a failure: rate limiting means the service is working and protecting itself.

**Note:** an outcome only gets classified if the operation _returned_ something with a `status`. HTTP
adapters return raw response objects, so a 503 is a success as far as the pipeline is concerned unless
you opt in with `retryOn`. See [HTTP adapters](../http/overview.md#status-codes-are-not-classified-by-default).

### Error outcomes

| Error                                              | `isFailure` | `isRetryable`          |
| -------------------------------------------------- | ----------- | ---------------------- |
| `TimeoutError`                                     | Yes         | Yes                    |
| `BulkheadRejectedError`                            | No          | Yes                    |
| `RateLimitExceededError`                           | No          | Yes                    |
| `CircuitOpenError`                                 | No          | No                     |
| `AbortError`, or any error named `AbortError`      | No          | No                     |
| `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EPIPE` | Yes         | **Only if idempotent** |
| Other `Error`                                      | Yes         | No                     |
| Non-`Error` thrown value                           | No          | No                     |

### Network errors and idempotency

A connection reset is ambiguous: the request may never have arrived, or it may have been processed
with the response lost. Retrying a non-idempotent write in that state can duplicate it.

Resili resolves the ambiguity by requiring an explicit signal:

```ts
await client.execute((ctx) => fetch(url, { signal: ctx.signal }), {
  metadata: { idempotent: true },
});
```

Without `metadata.idempotent === true`, a network error is a failure but not retryable. Safe by
default; you opt in per call.

### `retryAfter`

The default classifier extracts a delay hint from an HTTP `Retry-After` header, a
`RateLimitExceededError.retryAfterMs`, or a `CircuitOpenError.retryAfterMs`. When
`respectRetryAfter` is enabled (the default), retry uses that value instead of the backoff curve,
clamped to `maxDelayMs`.

Honoring the hint is strictly better than guessing — the server knows when it will be ready.

## `llmClassifier`

`@resili/llm` layers LLM semantics on top:

1. An `LlmError` uses its own `retryable` flag, which the adapter derived from the
   [classification](../llm/errors.md).
2. A core `TimeoutError` is retryable — subject to the streaming commit guard below.
3. Anything else falls through to `httpClassifier`.

Retryable classifications: `rate_limited`, `timeout`, `provider_unavailable`, `overloaded`,
`network_transient`. Not retryable: `authentication`, `authorization`, `invalid_request`,
`context_limit_exceeded`, `content_policy`, `budget`, `unknown`.

`unknown` fails closed deliberately — an unrecognized error might be transient or permanent, and
retrying blindly risks amplifying an outage.

## The stream commit guard

`createLlmClient` wraps whatever classifier you supply (or `llmClassifier`) with a guard that returns
`isRetryable: false` once a stream has committed — that is, once the first non-empty text delta has
been delivered to the consumer.

The guard exists because a post-commit retry would concatenate two generations into one corrupt
answer. It is **unconditional**: a custom classifier returning `true` for everything is still
overridden after commit. This is the one place where classification is not fully pluggable, and it is
deliberate — the invariant protects output correctness, not policy preference.

Mechanically, a mutable commit flag lives in context metadata, whose values are shared across retry
and timeout forks, so the outer classifier can observe a commit that happened on an inner attempt
context. See [Streaming](../llm/streaming.md#the-commit-point) and
[Execution context](../core/execution-context.md#metadata-values-are-shared-across-forks).

## Custom classifiers

```ts
import { httpClassifier, type FailureClassifier } from "@resili/core";

const classifier: FailureClassifier = {
  isFailure(outcome, ctx) {
    if (outcome.status === "error" && (outcome.error as { code?: string }).code === "MY_EXPECTED") {
      return false; // expected, do not open the breaker
    }
    return httpClassifier.isFailure(outcome, ctx);
  },
  isRetryable(outcome, ctx) {
    if (outcome.status === "success" && (outcome.value as { retryable?: boolean }).retryable) {
      return true; // an envelope-style API that signals retryability in the body
    }
    return httpClassifier.isRetryable(outcome, ctx);
  },
  retryAfter: httpClassifier.retryAfter,
};

const client = createClient(operation, { classifier, retry: { maxAttempts: 3, jitter: "none" } });
```

Delegating to the default for everything you do not handle is the pattern to follow — it keeps the
self-referential guarantees (`CircuitOpenError` not a failure, aborts not retryable) intact.

### `retryOn` versus a classifier

| Use             | When                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `retry.retryOn` | One client needs different retry rules. Overrides the classifier entirely for retry decisions. |
| `classifier`    | Failure _and_ retry semantics need changing, and consistently.                                 |

`retryOn` affects only retry. The circuit breaker still uses the classifier's `isFailure`, so
`retryOn` cannot make the breaker ignore something.

## Guidance

- Treat "should the breaker care?" and "should we try again?" as separate questions.
- Never let a policy's own rejection count as a dependency failure.
- Keep cancellation out of both — a user leaving is not an outage.
- Require explicit idempotency before retrying an ambiguous network error.
- Honor server-supplied `Retry-After`.
- Fail closed on unknown errors.
- Delegate the cases you have not thought about to the default classifier.
