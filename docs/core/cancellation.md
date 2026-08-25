# Cancellation

Resili's cancellation model is native `AbortSignal` throughout. There is no proprietary cancellation
token, no `cancel()` method on clients, and no bespoke propagation mechanism.

```text
AbortController (caller)
    ↓
Context.signal          composed with the deadline
    ↓
policy forks            timeout adds a per-attempt signal
    ↓
your operation          must forward ctx.signal
    ↓
HTTP client / LLM SDK
```

## The one rule

**Forward `ctx.signal`.** Everything else follows. Cancellation in Resili is cooperative: if your
operation ignores the signal, the timeout still rejects on schedule and the caller still gets an
error, but the underlying work keeps running in the background — the socket stays open, the tokens
keep being generated, the bill keeps accruing.

```ts
// ✅ Forwarded
await client.execute((ctx) => fetch(url, { signal: ctx.signal }));

// ❌ Not forwarded: the timeout rejects, the request continues
await client.execute(() => fetch(url));
```

## Three sources of cancellation

### Caller cancellation

Pass a signal when you execute. It is composed onto the context signal, so it reaches every layer.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

try {
  await client.execute((ctx) => fetch(url, { signal: ctx.signal }), {
    signal: controller.signal,
  });
} catch (error) {
  if (error instanceof AbortError || (error as Error).name === "AbortError") {
    // caller cancelled
  }
}
```

Under the default classifier an abort is **neither a failure nor retryable**. That is deliberate on
both counts: retry stops immediately instead of racing a cancelled request, and a user navigating
away does not push a healthy dependency toward an open circuit.

### Timeout cancellation

The [timeout](timeout.md) policy creates its own controller per attempt, forks the context with it,
and aborts it when the timer fires — with the `TimeoutError` as `signal.reason`.

The scope is exactly one attempt. The caller's signal is untouched, which is what allows retry to
start attempt two on a fresh signal.

```text
caller signal  ─────────────────────────────────────▶  (not aborted)
  attempt 1 signal  ──── aborted at perAttemptMs
  attempt 2 signal  ──── fresh controller
```

### Deadline cancellation

A context deadline aborts the composed signal when the absolute time is reached, with a `DOMException`
named `AbortError`. Unlike a per-attempt timeout this bounds the **whole logical call**, retries
included, which makes it the right tool for an end-to-end budget.

`TimeoutOptions.deadlineMs` is validated but has no runtime effect — use the context deadline.

## How policies handle cancellation

Behavior varies by policy, and the differences are worth knowing rather than assuming uniformity.

| Policy          | Cancellation behavior                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Timeout         | Creates the abort. Aborts its child signal only; never the parent.                                                     |
| Retry           | Does not read the signal. Stops because the classifier calls aborts non-retryable. A backoff sleep is not interrupted. |
| Circuit breaker | Does not read the signal. Aborts are not counted as failures.                                                          |
| Rate limiter    | **Wait mode** is fully cancellable and an aborted waiter consumes no token. Reject mode does not consult the signal.   |
| Bulkhead        | Does not observe the signal. A queued caller waits for a slot or `queueTimeoutMs`. Use `queueTimeoutMs` to bound it.   |
| Cache           | Checks once before lookup. An already-aborted call resolves no key and calls nothing.                                  |
| Dedupe          | Per-caller detach. With `abortSharedWhenUnused: true` the shared work is aborted when the last subscriber leaves.      |
| Hedge           | Parent abort cancels all attempts. Losers are aborted when `abortLosers` is `true`.                                    |
| Fallback        | Does not read the signal — so an `AbortError` is handled like any other error unless you exclude it.                   |

The fallback row is the one that catches people out:

```ts
import { AbortError } from "@resili/core";

fallback: {
  fallbackOn: (error) => !(error instanceof AbortError),
  handler: () => degraded(),
}
```

## HTTP adapters

All three adapters propagate cancellation the same way: they shallow-copy your request arguments and
set the signal field to `ctx.signal`.

| Adapter          | Field set        |
| ---------------- | ---------------- |
| `@resili/fetch`  | `init.signal`    |
| `@resili/axios`  | `config.signal`  |
| `@resili/undici` | `options.signal` |

**A signal you put on the request arguments is replaced, not merged.** Passing
`init.signal` to `resilientFetch` has no effect — the adapter overwrites it with the context signal.
Supply caller cancellation through the Resili context instead:

```ts
// ❌ Overwritten by the adapter
await resilientFetch(url, { signal: controller.signal });
```

The adapters also call `client.execute(operation)` with no `ContextInit`, so there is no other seam
for a caller signal. **Caller-initiated cancellation is not supported through the HTTP adapters in
this alpha** — only timeout-driven cancellation is. To abort from the caller, wrap the HTTP call with
`@resili/core` directly and pass the signal to `execute`:

```ts
// ✅ ctx.signal is aborted by the caller, the timeout, or both
await client.execute((ctx) => fetch(url, { signal: ctx.signal }), { signal: controller.signal });
```

See [HTTP adapters overview](../http/overview.md#cancellation-and-the-signal-you-cannot-pass).

## LLM providers

Every provider adapter forwards `ctx.signal` to the vendor SDK, using whichever field that SDK
expects:

| Adapter                 | Field                    |
| ----------------------- | ------------------------ |
| `@resili/llm-openai`    | request options `signal` |
| `@resili/llm-anthropic` | request options `signal` |
| `@resili/llm-gemini`    | `config.abortSignal`     |

`LlmGenerateRequest` also accepts a per-request `signal`, which is composed with the internal one:

```ts
const controller = new AbortController();
const result = await llm.generate({ input: "…", signal: controller.signal });
```

Each adapter recognizes its SDK's abort errors and **rethrows them unchanged** rather than converting
them to an `LlmError` — so a cancellation stays a cancellation and is never misclassified as a
provider failure. OpenAI and Anthropic pass through `AbortError` and `APIUserAbortError`; Gemini also
treats a `DOMException` and HTTP `499` as aborts.

## Streaming cancellation

Streaming has two cancellation paths, and they converge on the same outcome.

### Early break

Breaking out of `for await` runs the iterator's `return()`, which aborts the pump, closes the
provider iterator when the SDK exposes `return()`, ends the underlying core execution, and settles any
Budget Guard reservation. No `completed` event is yielded, and `result()` rejects with `AbortError`.

```ts
const stream = llm.stream({ input: "Write an essay" });

let printed = 0;
for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
    printed += event.text.length;
    if (printed > 500) {
      break; // provider iterator is closed
    }
  }
}
```

### Caller abort

Aborting the signal rejects the pending `next()` and ends execution. This works both before and after
the stream has committed, and in **neither** case does it trigger a retry — a cancellation is never
retried.

```ts
const controller = new AbortController();
const stream = llm.stream({ input: "…", signal: controller.signal });

setTimeout(() => controller.abort(), 2_000);

try {
  for await (const event of stream) {
    /* … */
  }
} catch {
  // aborted mid-stream
}
```

One caveat specific to interrupted streams: providers often do not report token usage when a stream
is cut short. Resili settles the budget reservation with zero actual cost rather than inventing token
counts, so provider-side billed tokens for an interrupted stream may be unrepresented. See
[Budget Guard](../llm/budget-guard.md).

Calling `return()` before the very first `next()` — cancelling a stream you never started — rejects
`result()` with `AbortError` and never opens the provider stream at all.

## Errors you will see

| Error                             | Source                               |
| --------------------------------- | ------------------------------------ |
| `AbortError` (`ERR_ABORTED`)      | Resili's own cancellation paths      |
| `DOMException` named `AbortError` | Deadline abort, and most native APIs |
| `TimeoutError` (`ERR_TIMEOUT`)    | Per-attempt timeout                  |
| SDK-native abort errors           | Rethrown unchanged by LLM adapters   |

Because cancellation can surface as either a Resili `AbortError` or a native `DOMException`, check
both when you need to distinguish cancellation from failure:

```ts
import { AbortError } from "@resili/core";

const isCancellation = (error: unknown) =>
  error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
```

## Limitations

- Cancellation is cooperative. Work that ignores the signal is abandoned, not killed.
- Retry does not interrupt an in-progress backoff sleep.
- The bulkhead queue does not respond to cancellation; bound it with `queueTimeoutMs`.
- HTTP adapters replace a request-level signal rather than composing it.
- Interrupted streams may not carry authoritative provider usage.
