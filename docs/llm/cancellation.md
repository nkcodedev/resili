# LLM cancellation

LLM cancellation follows the general [cancellation model](../core/cancellation.md). This page covers
what is specific to LLM calls: how each SDK receives the signal, how abort errors are preserved, and
what happens to usage and cost when a stream is cut short.

## Passing a signal

`LlmGenerateRequest` accepts a per-request `signal`, composed with Resili's internal abort controller.

```ts
const controller = new AbortController();

// Unary
const promise = llm.generate({ input: prompt, signal: controller.signal });

// Streaming
const stream = llm.stream({ input: prompt, signal: controller.signal });

controller.abort();
```

Aborting rejects the pending `generate()` promise, or the pending `next()` on a stream.

If the caller signal is **already aborted** when `generate()` is invoked, the provider is not called.
The same check runs on the first `stream()` `next()` so a lazy stream does not open the provider.

## Signal delivery to the SDK

Every adapter forwards `ctx.signal` — the composed signal, so caller aborts, per-attempt timeouts, and
deadlines all arrive by the same route. The field differs per SDK:

| Adapter                 | Field                    | Unary | Streaming |
| ----------------------- | ------------------------ | ----- | --------- |
| `@resili/llm-openai`    | request options `signal` | ✓     | ✓         |
| `@resili/llm-anthropic` | request options `signal` | ✓     | ✓         |
| `@resili/llm-gemini`    | `config.abortSignal`     | ✓     | ✓         |

Because the signal reaches the SDK, cancellation closes the underlying HTTP connection rather than
merely abandoning a promise — which is what actually stops token generation and further billing.

## Abort errors are preserved, not classified

Adapters recognize their SDK's cancellation errors and **rethrow them unchanged** instead of mapping
them to an [`LlmError`](errors.md).

| Adapter   | Recognized as cancellation                      |
| --------- | ----------------------------------------------- |
| OpenAI    | `AbortError`, `APIUserAbortError`               |
| Anthropic | `AbortError`, `APIUserAbortError`               |
| Gemini    | `AbortError`, `DOMException`, HTTP status `499` |

This matters for two reasons. A cancellation is never misclassified as a provider failure, so it does
not count toward opening a [circuit breaker](../core/circuit-breaker.md) — a user closing a browser tab
should not make a healthy provider look unhealthy. And because the default classifier treats aborts as
neither failures nor retryable, cancellation **never triggers a retry** in any phase.

Detecting cancellation therefore means checking abort shapes rather than `isLlmError`:

```ts
import { AbortError } from "@resili/core";

const isCancellation = (error: unknown) =>
  error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
```

## Unary cancellation

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);

try {
  const result = await llm.generate({ input: prompt, signal: controller.signal });
  return result.response.content;
} catch (error) {
  if (isCancellation(error)) {
    return null;
  }
  throw error;
} finally {
  clearTimeout(timer);
}
```

A cancelled `generate()` returns no usage, because the response never arrived. The provider may still
have billed for tokens it generated before the connection closed; Resili has no way to observe that
and does not estimate it.

## Streaming cancellation

Two paths, converging on the same cleanup.

### Early `break`

Breaking out of `for await` runs `iterator.return()`, which aborts the pump, closes the provider
iterator when the SDK exposes `return()`, ends the core execution, and settles the budget reservation.

```ts
const stream = llm.stream({ input: "Write a long essay" });

let printed = 0;
for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
    printed += event.text.length;
    if (printed > 1_000) break; // enough
  }
}
```

No `completed` event is yielded and `result()` rejects with `AbortError`. Reading `result()` after a
deliberate `break` is a common mistake — the stream was cancelled, so there is no result.

### Caller abort

```ts
const controller = new AbortController();
const stream = llm.stream({ input: prompt, signal: controller.signal });

setTimeout(() => controller.abort(), 5_000);

try {
  for await (const event of stream) {
    if (event.type === "text-delta") process.stdout.write(event.text);
  }
} catch (error) {
  if (isCancellation(error)) {
    console.log("\n[cancelled]");
  } else {
    throw error;
  }
}
```

### Cancelling before consumption

Calling `return()` before the first `next()` returns `{ done: true }`, never opens the provider stream,
and rejects `result()` with `AbortError`. A stream you create and then discard without iterating never
calls the provider at all — [execution is lazy](streaming.md#lazy-start).

### Commit state does not change cancellation

Unlike failures, cancellation behaves identically before and after the
[commit point](streaming.md#the-commit-point): no retry, in either phase. There is nothing to
retry — the caller asked to stop.

## Usage and cost after cancellation

The honest limitation.

When a stream is interrupted, providers frequently do not send the final usage frame. Resili settles
the Budget Guard reservation with **zero** actual cost rather than inventing token counts, so:

- `result()` rejects, and there is no authoritative usage to read.
- The budget records zero spend for that request.
- The provider may nonetheless bill for the tokens it generated.

**Resili cannot know provider billing for an interrupted stream when the provider does not return
usage.** If you cancel streams routinely — user-facing "stop generating" buttons, aggressive
timeouts — expect Resili's accumulated cost to under-report your actual bill, and reconcile against
provider billing rather than treating Resili's figure as authoritative. See
[Budget Guard](budget-guard.md).

Counting delivered text as a proxy is possible but approximate:

```ts
let deliveredChars = 0;
try {
  for await (const event of stream) {
    if (event.type === "text-delta") deliveredChars += event.text.length;
  }
} catch (error) {
  if (isCancellation(error)) {
    // Rough lower bound on generated output; not a token count.
    metrics.observe("llm.cancelled_chars", deliveredChars);
  }
}
```

## Timeouts as cancellation

A per-attempt [timeout](timeouts.md) is cancellation with a timer. It aborts the _attempt's_ signal —
not the caller's — which is what lets pre-commit retries start a fresh attempt.

The difference from a caller abort is the error you see: `TimeoutError` (or a normalized non-retryable
`LlmError("timeout")` post-commit) rather than an abort error, and pre-commit timeouts _are_ retried
whereas cancellations never are.

## Cleanup

Always `destroy()` a client you are finished with. It clears event listeners and disposes plugin
resources, and it is idempotent.

```ts
const llm = createLlmClient({ provider /* … */ });
try {
  await llm.generate({ input: prompt });
} finally {
  await llm.destroy();
}
```

`destroy()` does not cancel in-flight requests. Cancel those through their own signals first.

## Limitations

- Cancellation is cooperative; a custom adapter that ignores `ctx.signal` will keep generating.
- Interrupted streams may not carry authoritative usage, so their cost may be unrepresented.
- `destroy()` does not abort in-flight work.
- Abort errors are not `LlmError`s, so `isLlmError` returns `false` for them — check abort shapes
  explicitly.
