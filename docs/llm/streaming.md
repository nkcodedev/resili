# Streaming

`client.stream()` returns an `LlmStream` that yields text as the provider produces it. Streaming is
additive — `generate()` is unchanged.

## Pull-through execution

Resili does not read the provider's stream into a buffer and hand you the pieces. Your consumption
drives the provider.

```text
consumer next()
    ↓
Resili execute()          the core pipeline stays open for the whole stream
    ↓
provider.stream()
    ↓
provider SDK iterator
```

The pump waits for consumer demand, pulls exactly one frame from the provider iterator, and delivers
at most one event before waiting again. Backpressure is therefore natural: a slow consumer slows the
provider read rather than accumulating chunks in memory. Resili does not intentionally buffer the
complete response, and it does not read ahead of your loop.

One consequence to keep in mind: the core `execute()` call remains pending for the entire consumer
lifetime — until completion, failure, abort, or an early `break`. Any policy state held for the
duration of an execution, such as a bulkhead slot, is held for as long as you are consuming.

## Lazy start

Creating a stream does nothing. The provider is not called until the first `next()`.

```ts
const stream = llm.stream({ input: "…" }); // no provider call yet

for await (const event of stream) {
  // the first iteration opens the provider stream
}
```

**`result()` does not start execution.** Awaiting `result()` on a stream you never iterate leaves the
promise pending forever — it is not a shortcut for "give me the whole response".

```ts
// ❌ Hangs. Nothing ever pulls from the provider.
const result = await llm.stream({ input: "…" }).result();

// ✅ Consume, then read the terminal result.
const stream = llm.stream({ input: "…" });
for await (const event of stream) {
  /* … */
}
const result = await stream.result();
```

Use [`generate()`](generate.md) when you want the complete response in one call.

## Types

```ts
interface LlmStream {
  [Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent, undefined>;
  result(): Promise<LlmStreamResult>;
}

type LlmStreamEvent = LlmStreamTextDelta | LlmStreamCompleted;

interface LlmStreamTextDelta {
  readonly type: "text-delta";
  readonly text: string; // always non-empty
}

interface LlmStreamCompleted {
  readonly type: "completed";
  readonly provider: string;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly finishReason: LlmFinishReason;
  readonly cost?: LlmCost;
}

interface LlmStreamResult {
  readonly provider: string;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly finishReason: LlmFinishReason;
  readonly cost?: LlmCost;
}
```

Two event types only. Provider metadata frames — model identity, interim usage — are consumed
internally and folded into the final `completed` event rather than surfaced as events, and empty text
deltas are never yielded.

**There is no error event.** Failures reject the iterator. A successful stream ends with `completed`;
an unsuccessful one throws.

`result()` resolves with the same information as the `completed` event, minus the `type`. Multiple
calls share one promise, and an unawaited `result()` will not produce an unhandled rejection warning.

```ts
const stream = llm.stream({ input: "Explain backpressure." });

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }
  if (event.type === "completed") {
    console.log("\ntokens:", event.usage.totalTokens, "reason:", event.finishReason);
  }
}
```

## The commit point

This is the concept that governs streaming retry semantics.

**A stream becomes committed when the first non-empty text delta has been successfully delivered to
the consumer.** Delivered, not produced: the frame must have been handed to a waiting `next()`.
Metadata frames do not commit. Empty text does not commit.

| Phase             | On a retryable failure or per-attempt timeout               |
| ----------------- | ----------------------------------------------------------- |
| **Before commit** | May retry, according to the retry policy and the classifier |
| **After commit**  | **Must not** start another provider generation              |

### Why

Without a commit point, a timeout after partial output would start a second generation, and its text
would be concatenated onto the first:

```text
generation 1 → "The circuit breaker pattern"
timeout
generation 2 → "The circuit breaker pattern prevents cascading failures"

consumer sees:  "The circuit breaker patternThe circuit breaker pattern prevents cascading failures"
```

That output is corrupt in a way that is difficult to detect downstream — it is not an error, just a
plausible-looking answer that says things twice. The commit point guarantees that **the visible text
of one logical stream comes from exactly one provider generation.**

### How it is enforced

The retry classifier is wrapped so that, once a stream is committed, `isRetryable` returns `false` for
**any** failure — including a core per-attempt `TimeoutError`, which the classifier would otherwise
call retryable. A commit flag is carried in context metadata, whose values are shared across retry and
timeout context forks, so an outer classifier can observe a commit that happened on an inner attempt
context. See [Execution context](../core/execution-context.md#metadata-values-are-shared-across-forks).

This override is unconditional: a custom `classifier` that returns `true` for everything is still
overridden after commit. The invariant is not negotiable through configuration.

### alpha.4 behavior

| Situation                    | Retry           | Terminal error                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------- |
| Post-commit timeout          | **No**          | `LlmError`, `classification: "timeout"`, `retryable: false`   |
| Post-commit provider failure | **No**          | `LlmError` with the mapped classification, `retryable: false` |
| Pre-commit timeout           | Yes, per policy | `RetryExceededError` once attempts are exhausted              |
| Pre-commit provider failure  | Yes, per policy | `RetryExceededError`, or the error itself if not retryable    |
| Cancellation (any phase)     | **No**          | Abort error, unchanged                                        |

The post-commit `LlmError` is what you observe at the public boundary in all three places: from the
iterator, from `result()`, and on the `LlmStreamFailed` event (which carries `committed: true`).

In `@resili/llm` `0.1.0-alpha.3` a per-attempt timeout after committed text was still classified
retryable, so `retry.maxAttempts > 1` could start additional generations. Fixed in `0.1.0-alpha.4`.
Upgrade if you use streaming with retries.

## Timeout scope

`timeout.perAttemptMs` bounds the **entire streaming attempt**, including time the pump spends waiting
for your consumer to pull. A slow consumer can time out a healthy provider stream.

```ts
// A 30s budget for the whole stream, consumer pauses included.
timeout: {
  perAttemptMs: 30_000;
}
```

There is no separate time-to-first-token timeout and no idle/inter-chunk timeout in this alpha. If you
need to bound your own processing, do the slow work outside the loop:

```ts
const chunks: string[] = [];
for await (const event of stream) {
  if (event.type === "text-delta") {
    chunks.push(event.text); // fast
  }
}
await persist(chunks.join("")); // slow work after the stream closes
```

See [Timeouts](timeouts.md).

## Early termination

### `break`

Breaking out of `for await` invokes `iterator.return()`, which aborts the pump, closes the provider
iterator when the SDK exposes `return()`, ends the core execution, and settles the budget
reservation. No `completed` event is yielded, and `result()` rejects with `AbortError`.

```ts
let printed = 0;
for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
    printed += event.text.length;
    if (printed > 500) break;
  }
}
// stream.result() now rejects with AbortError
```

### `return()` before the first `next()`

Cancelling a stream you never started returns `{ done: true }`, never opens the provider stream, and
rejects `result()` with `AbortError`.

### `throw()`

Injecting an error via `iterator.throw(error)` fails the stream with that error, and `result()`
rejects with the same error. Before execution has started it simply fails the terminal promise; after
it has started, the pump is aborted and the pending delivery rejects.

## Cancellation

A caller `signal` is composed with Resili's internal abort controller.

```ts
const controller = new AbortController();
const stream = llm.stream({ input: "…", signal: controller.signal });
setTimeout(() => controller.abort(), 5_000);
```

Aborting rejects the pending `next()`. Cancellation never retries, before or after commit. See
[Cancellation](cancellation.md).

## Concurrent `next()` is rejected

The pump serves one demand at a time. A second `next()` while one is outstanding throws an `LlmError`
with `classification: "invalid_request"` and does **not** open a second provider stream.

Practically this means one consumer per stream. `for await` and manual sequential `next()` are both
fine; racing two `next()` calls is not.

## Usage, cost, and Budget Guard

The `completed` event and `result()` carry authoritative provider usage where the provider reports it,
with cost computed from your price table.

Budget Guard wraps the same execution lifetime: estimate, reserve, consume the stream, then settle
against actual usage. When a stream is interrupted — aborted, timed out, or broken out of — the
reservation is settled with **zero** actual cost, because Resili does not invent token counts. The
provider may still have billed for tokens it generated, so **interrupted streams may not contain
authoritative provider usage**, and Resili cannot represent that spend. See
[Budget Guard](budget-guard.md).

## Telemetry

Three stream events: `LlmStreamStarted`, `LlmStreamCompleted` (`durationMs`, `ttftMs?`, `chunkCount`,
token counts, `costMicroUsd?`), and `LlmStreamFailed` (`durationMs`, `classification`, `retryable`,
`committed`).

Text deltas are **not** published on the event bus, and no event or metric contains prompts,
completions, or raw provider chunks. `committed` on the failure event is the field to alert on: a
post-commit failure means a user saw partial output.

```ts
llm.onCore("RetryStarted", (event) => console.log("retry", event.attemptNumber));
llm.on("LlmStreamFailed", (event) => {
  if (event.committed) {
    console.error("partial output delivered before failure", event.classification);
  }
});
```

See [Telemetry](../observability/telemetry.md).

## Complete example

```ts
import OpenAI from "openai";
import { createLlmClient, createPricingResolver, isLlmError } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({ client: new OpenAI() }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 60_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 500, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
  ]),
});

const controller = new AbortController();
const stream = llm.stream({ input: "Explain pull-through streaming.", signal: controller.signal });

try {
  for await (const event of stream) {
    if (event.type === "text-delta") {
      process.stdout.write(event.text);
    }
    if (event.type === "completed") {
      console.log(`\n${event.usage.totalTokens} tokens, $${event.cost?.totalCostUsd ?? "?"}`);
    }
  }

  const result = await stream.result();
  console.log(result.finishReason);
} catch (error) {
  if (isLlmError(error) && error.classification === "timeout" && !error.retryable) {
    console.error("\nstream timed out after partial output");
  } else {
    throw error;
  }
} finally {
  await llm.destroy();
}
```

## Limitations

- `result()` does not start execution; the consumer must iterate or call `next()`.
- `perAttemptMs` covers the full streaming attempt, consumer wait included.
- No separate time-to-first-token timeout.
- No separate idle / inter-chunk timeout.
- Interrupted streams may not contain authoritative provider usage, so their real cost may be
  unrepresented.
- One consumer per stream; concurrent `next()` is rejected.
- Text deltas only — no tool-call, reasoning, or structured-output frames.
- No error event type; failures reject the iterator.
