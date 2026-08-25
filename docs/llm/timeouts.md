# LLM timeouts

Timeouts use core's [timeout policy](../core/timeout.md). What is LLM-specific is how long an attempt
legitimately takes, and what `perAttemptMs` covers when streaming.

## Configuration

```ts
const llm = createLlmClient({
  provider,
  timeout: { perAttemptMs: 60_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});
```

`perAttemptMs` is required — there is no default. `timeout.deadlineMs` throws; use a context deadline
for an end-to-end bound.

The timeout is **per attempt** and renewed on each retry, so `perAttemptMs: 60_000` with
`maxAttempts: 3` is a worst case near three minutes plus backoff, not one.

## Choosing a value

LLM latency scales with output length, which makes HTTP intuitions misleading. A 30-token answer might
return in 500 ms; a 2000-token answer on a large model can take a minute or more, and reasoning models
longer still.

| Workload                           | Starting point |
| ---------------------------------- | -------------- |
| Short classification or extraction | 5–15 s         |
| Chat-length answers                | 30–60 s        |
| Long generation (documents, code)  | 60–180 s       |
| Reasoning models                   | 120–300 s      |

Measure `LlmRequestCompleted.durationMs` in your own traffic and set the timeout above your p99 rather
than guessing. Note that a `max_tokens` limit indirectly bounds latency — capping output is often a
better control than a tight timeout, because it fails _gracefully_ with
`finishReason: "length"` instead of throwing.

## Unary timeouts

A timed-out `generate()` attempt raises `TimeoutError`. The context signal is aborted, and every
adapter forwards it to the SDK, so the HTTP request is genuinely cancelled rather than abandoned.

`TimeoutError` is retryable, so with retry configured a timeout starts the next attempt; exhausting
attempts yields `RetryExceededError` with `lastError instanceof TimeoutError`.

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";

try {
  await llm.generate({ input: prompt });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error(`attempt exceeded ${error.timeoutMs}ms`);
  }
  if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    console.error(`all ${error.attempts} attempts timed out`);
  }
}
```

A cancelled attempt may still be billed — the provider generated tokens before you hung up. Resili
cannot represent that spend, since a cancelled request returns no usage.

## Streaming timeouts

Here is the part that differs from every other Resili timeout.

**`perAttemptMs` covers the entire streaming attempt, including time the pump spends waiting for your
consumer to pull.** Because streaming is [pull-through](streaming.md#pull-through-execution), a slow
consumer is indistinguishable from a slow provider as far as the timer is concerned.

```text
attempt clock starts
├── provider connect
├── first token
├── … deltas, interleaved with consumer processing time ──┐
└── completed                                              │
                          all of this counts against perAttemptMs
```

So this times out even though the provider is healthy:

```ts
// ❌ 10 chunks × 2s of processing = 20s, over a 15s budget
const llm = createLlmClient({ provider, timeout: { perAttemptMs: 15_000 } });

for await (const event of stream) {
  if (event.type === "text-delta") {
    await slowDatabaseWrite(event.text); // counts against the timeout
  }
}
```

Consume fast, then do slow work after the stream closes:

```ts
// ✅ Collect quickly, persist afterwards
const chunks: string[] = [];
for await (const event of stream) {
  if (event.type === "text-delta") {
    chunks.push(event.text);
    process.stdout.write(event.text);
  }
}
await slowDatabaseWrite(chunks.join(""));
```

Or size `perAttemptMs` to include your processing budget, accepting that a genuinely stalled provider
then takes longer to detect.

### Pre-commit versus post-commit

The commit point changes what a streaming timeout means.

| Phase           | Retried?        | Terminal error                                                |
| --------------- | --------------- | ------------------------------------------------------------- |
| **Pre-commit**  | Yes, per policy | `RetryExceededError` with `lastError instanceof TimeoutError` |
| **Post-commit** | **No**          | `LlmError`, `classification: "timeout"`, `retryable: false`   |

A post-commit timeout cannot retry, because a second generation would duplicate the text already shown.
It is normalized to a non-retryable `LlmError` so that non-retryability is explicit wherever you
observe it — the iterator, `result()`, and `LlmStreamFailed` (with `committed: true`).

```ts
import { RetryExceededError, TimeoutError } from "@resili/core";
import { isLlmError } from "@resili/llm";

try {
  for await (const event of stream) {
    /* … */
  }
} catch (error) {
  if (isLlmError(error) && error.classification === "timeout") {
    // partial output was delivered; do not retry
  } else if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    // nothing was shown; safe to retry at the application level
  }
}
```

See [Streaming](streaming.md#the-commit-point) and [Retries](retries.md).

## What is not implemented

Three timeout flavors you might expect from a streaming API are **not** available in this alpha:

- **Time to first token.** No separate TTFB bound. A provider that connects and then stalls for
  50 seconds before its first token is only caught by the full `perAttemptMs`.
- **Idle / inter-chunk timeout.** No bound on the gap between deltas. A stream that stops mid-sentence
  without closing is only caught by `perAttemptMs`.
- **Overall multi-attempt deadline via timeout policy.** `timeout.deadlineMs` throws. Use
  `ContextInit.deadline` / `deadlineMs`.

Until these exist, `perAttemptMs` is the only timing control, and it is a blunt one. A caller
`AbortController` gives you application-level control:

```ts
const controller = new AbortController();
const stream = llm.stream({ input: prompt, signal: controller.signal });

let lastChunkAt = Date.now();
const idleCheck = setInterval(() => {
  if (Date.now() - lastChunkAt > 10_000) controller.abort();
}, 1_000);

try {
  for await (const event of stream) {
    lastChunkAt = Date.now();
    if (event.type === "text-delta") process.stdout.write(event.text);
  }
} finally {
  clearInterval(idleCheck);
}
```

## Interaction with other policies

- **Retry** is outside, so each attempt gets a fresh timer.
- **Circuit breaker** is outside the timeout, and `TimeoutError` counts as a failure — persistent
  timeouts will open the breaker, which is usually desirable.
- **Rate limiter** in wait mode is inside, so queue latency counts against `perAttemptMs`; keep
  `maxWaitMs` well below it.
- **Bulkhead** queue wait also counts; keep `queueTimeoutMs` below `perAttemptMs`.

## Observability

```ts
llm.onCore("TimeoutTriggered", (event) => {
  console.warn(`attempt ${event.attemptNumber} timed out after ${event.timeoutMs}ms`);
});
llm.on("LlmStreamFailed", (event) => {
  if (event.classification === "timeout") {
    console.error(`stream timeout, committed=${event.committed}`);
  }
});
```

`committed` is the field worth alerting on — a committed timeout means a user saw a truncated answer.

## Recommendations

- Set `perAttemptMs` from measured p99, not intuition.
- Keep the consumer loop cheap; defer slow work until after the stream.
- Prefer `max_tokens` limits over tight timeouts for bounding cost and latency.
- Use a caller `AbortController` if you need TTFB or idle semantics today.
- Alert on committed stream timeouts separately from pre-commit ones — they have different user impact.
