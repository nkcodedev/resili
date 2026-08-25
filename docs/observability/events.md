# Events

Events are Resili's high-cardinality observability surface. They carry `requestId` and are intended
for tracing, debugging, and audit — as opposed to [metrics](metrics.md), which are deliberately
low-cardinality.

There are two buses: core's closed event map, and `@resili/llm`'s additive one.

## Subscribing

```ts
const unsubscribe = client.on("RequestCompleted", (event) => {
  console.log(event.operationName, event.status, event.durationMs);
});

unsubscribe();
```

On an LLM client, `on` is the LLM bus and `onCore` is core's:

```ts
llm.on("LlmRequestCompleted", (event) => console.log(event.totalTokens));
llm.onCore("RetryStarted", (event) => console.log(event.attemptNumber));
```

`client.destroy()` removes all subscriptions.

### Handler errors are isolated

A throwing handler is caught and never propagates to the caller. One bad listener cannot fail a
request or prevent other listeners from running. Do not rely on a handler throwing to signal anything.

Handlers run **synchronously** in the request path, so keep them cheap. Buffer or queue rather than
awaiting I/O inside a handler.

## Core events

Every core event includes:

```ts
interface ResiliEventBase {
  readonly type: ResiliEventType;
  readonly timestamp: number;
  readonly requestId: string;
  readonly operationName: string;
  readonly serviceName: string;
}
```

The core event map is **closed** — twenty-nine types, no extension point. That is why `@resili/llm` has
its own bus rather than adding to this one.

### Request lifecycle

| Event              | Additional fields                                                      |
| ------------------ | ---------------------------------------------------------------------- |
| `RequestStarted`   | `deadline`                                                             |
| `RequestCompleted` | `durationMs`, `status: "success" \| "error"`, `attempts`, `errorCode?` |

`errorCode` is present only when the failure is a Resili error. `attempts` is where you see the real
cost of retries.

### Retry

| Event            | Additional fields                     |
| ---------------- | ------------------------------------- |
| `RetryStarted`   | `attemptNumber`, `delayMs`, `reason?` |
| `RetryCompleted` | `attempts`, `totalDelayMs`            |
| `RetryFailed`    | `attempts`, `lastErrorCode?`          |

`RetryCompleted` fires only when at least one retry occurred, so it means "recovered after retrying" —
a useful signal on its own.

### Timeout

| Event              | Additional fields            |
| ------------------ | ---------------------------- |
| `TimeoutTriggered` | `attemptNumber`, `timeoutMs` |

### Circuit breaker

| Event               | Additional fields               |
| ------------------- | ------------------------------- |
| `CircuitOpened`     | `key`, `failureRate`, `resetAt` |
| `CircuitHalfOpened` | `key`, `probesAllowed`          |
| `CircuitClosed`     | `key`                           |

State transitions are usually worth alerting on directly — `CircuitOpened` means traffic to a
dependency has stopped.

### Admission control

| Event              | Additional fields                               |
| ------------------ | ----------------------------------------------- |
| `RateLimited`      | `key`, `strategy`, `retryAfterMs`, `waited`     |
| `BulkheadRejected` | `key`, `maxConcurrent`, `queueSize`, `waitedMs` |

In rate-limiter wait mode, `RateLimited` can fire twice for one call — once on the initial denial, and
again with `waited: true` if it is ultimately rejected.

### Cache

`CacheHit`, `CacheMiss`, `CacheStored`, `CacheExpired`, `CacheEvicted`, `CacheSkipped`.

Cache keys are **not** included in payloads, since they are derived from your operation arguments and
could contain user data.

### Dedupe

`DedupeMiss`, `DedupeJoined`, `DedupeCompleted`, `DedupeFailed`, `DedupeCallerAborted`,
`DedupeSharedAborted`.

### Hedge

`HedgeScheduled`, `HedgeStarted`, `HedgeCompleted`, `HedgeFailed`, `HedgeAborted`, `HedgeSkipped`.

`HedgeSkipped` means the delay would have exceeded the deadline. Frequent skips mean the delay is too
long relative to your deadline.

## LLM events

Every LLM event includes:

```ts
interface LlmEventBase {
  readonly type: LlmEventType;
  readonly timestamp: number;
  readonly requestId: string;
  readonly operationName: string; // "llm.generate" | "llm.stream"
  readonly provider: string;
  readonly model: string;
}
```

Unlike metrics, LLM events **do** carry `provider` and `model` — that is exactly the per-model
attribution that would be too high-cardinality for a metric label.

### Unary

| Event                 | Additional fields                                                           |
| --------------------- | --------------------------------------------------------------------------- |
| `LlmRequestStarted`   | —                                                                           |
| `LlmRequestCompleted` | `durationMs`, `inputTokens`, `outputTokens`, `totalTokens`, `costMicroUsd?` |
| `LlmRequestFailed`    | `durationMs`, `classification`, `retryable`                                 |
| `LlmUsageRecorded`    | `inputTokens`, `outputTokens`, `totalTokens`, `costMicroUsd?`               |

`costMicroUsd` is absent when the price is unknown — absent means unknown, not zero.

### Budget

| Event               | Additional fields                                                                 |
| ------------------- | --------------------------------------------------------------------------------- |
| `LlmBudgetWarning`  | `scope`, `accumulatedMicroUsd`, `limitMicroUsd`                                   |
| `LlmBudgetRejected` | `scope`, `limitKind`, `accumulatedMicroUsd`, `attemptedMicroUsd`, `limitMicroUsd` |

### Streaming

| Event                | Additional fields                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `LlmStreamStarted`   | —                                                                                                    |
| `LlmStreamCompleted` | `durationMs`, `ttftMs?`, `chunkCount`, `inputTokens`, `outputTokens`, `totalTokens`, `costMicroUsd?` |
| `LlmStreamFailed`    | `durationMs`, `classification`, `retryable`, **`committed`**                                         |

Two fields deserve attention.

`ttftMs` is time to first token — the number that determines whether streaming feels responsive, and
the one to track since there is no TTFT timeout to enforce it.

`committed` on `LlmStreamFailed` tells you whether the user saw partial output before the failure.
Post-commit failures cannot be retried and leave a truncated answer on screen, so they warrant a
separate alert from pre-commit ones. See [Streaming](../llm/streaming.md#the-commit-point).

**Text deltas are not published as events.** The event bus never carries generated text.

## Privacy

No event payload contains prompts, completions, raw provider chunks, request or response bodies, API
keys, or authorization headers. Cache and dedupe keys are excluded too. See
[Telemetry and privacy](telemetry.md).

## Patterns

Structured logging:

```ts
llm.onCore("RequestCompleted", (event) => {
  logger.info({
    requestId: event.requestId,
    operation: event.operationName,
    status: event.status,
    durationMs: event.durationMs,
    attempts: event.attempts,
    errorCode: event.errorCode,
  });
});
```

Alerting on the events that indicate real degradation:

```ts
client.on("CircuitOpened", (event) => {
  alerts.page(`circuit open for ${event.key} at ${event.failureRate}%`);
});

llm.on("LlmStreamFailed", (event) => {
  if (event.committed) {
    alerts.warn(`truncated stream: ${event.classification}`);
  }
});

llm.on("LlmBudgetWarning", (event) => {
  const pct = (event.accumulatedMicroUsd / event.limitMicroUsd) * 100;
  alerts.warn(`budget ${event.scope} at ${pct.toFixed(0)}%`);
});
```

Correlating attempts within a request:

```ts
client.on("RetryStarted", (e) =>
  trace(e.requestId, `retry ${e.attemptNumber} after ${e.delayMs}ms`),
);
client.on("TimeoutTriggered", (e) => trace(e.requestId, `timeout on attempt ${e.attemptNumber}`));
client.on("RequestCompleted", (e) => trace(e.requestId, `done in ${e.durationMs}ms`));
```

## Limitations

- The core event map is closed; custom events need your own mechanism.
- Handlers are synchronous and in the request path.
- Handler exceptions are swallowed.
- No built-in OpenTelemetry, Prometheus, or log exporter — wire events to your stack yourself.
- Not every policy emits events: retry, timeout, circuit breaker, rate limiter, bulkhead, cache,
  dedupe, and hedge do; **fallback does not**.
