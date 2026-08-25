# Timeout

Bounds a single attempt and cancels it through an `AbortSignal`.

**Pipeline position:** order `400` — inside retry and the circuit breaker, outside dedupe, hedge, and
admission control.

## When to use it

Always, for anything that crosses a network boundary. An unbounded call is the most common way a
single slow dependency turns into an outage: sockets accumulate, the event loop backs up, and
upstream callers time out with no useful signal.

## Configuration

```ts
interface TimeoutOptions {
  readonly perAttemptMs: number;
}
```

`perAttemptMs` is **required** — there is no default timeout. A number shorthand is accepted:

```ts
createClient(operation, { timeout: 1_000 });
createClient(operation, { timeout: { perAttemptMs: 1_000 } });
```

There is no `TimeoutOptions.deadlineMs`. Passing it throws `ConfigurationError`. Whole-request
deadlines are owned by the root context: pass `deadline` or `deadlineMs` to `execute` /
`ContextInit`.

## Behavior

1. Creates its own `AbortController`.
2. Forks the context with that controller's signal composed onto the parent's, keeping the same
   `attemptNumber`.
3. Starts a timer through the injected `Clock` and races it against `next(childContext)`.
4. If the timer wins, it aborts the child controller with a `TimeoutError` as the abort reason, emits
   `TimeoutTriggered`, and rejects with that `TimeoutError`.
5. The timer is always cleared afterwards — on success, on failure, and on timeout.

The semantics are strictly **per attempt**. Each time retry re-enters this policy, a new controller
and a new timer are created.

## Errors

`TimeoutError` (`ERR_TIMEOUT`) carries:

| Property        | Meaning                           |
| --------------- | --------------------------------- |
| `timeoutMs`     | The `perAttemptMs` that elapsed   |
| `attemptNumber` | Which attempt timed out           |
| `context`       | A snapshot of the attempt context |

A failure that arrives before the timer fires is rethrown unchanged.

## AbortSignal

This is the policy that turns time into cancellation.

- The **child** signal is aborted, with the `TimeoutError` as `signal.reason`. Downstream code that
  honors `ctx.signal` — including every HTTP and LLM adapter — stops promptly.
- The **caller's** signal is never aborted by a timeout. One attempt timing out does not cancel the
  logical request, which is exactly what lets retry start attempt two.
- A caller abort propagates _into_ the attempt through the composed signal.

The practical requirement: your operation must forward `ctx.signal` to whatever it calls. If it
ignores the signal, the timeout still rejects on schedule, but the underlying work keeps running in
the background.

```ts
const client = createClient(
  // ✅ signal is forwarded
  async (url: string, signal: AbortSignal) => fetch(url, { signal }),
  { timeout: { perAttemptMs: 1_000 } },
);

// Prefer execute() when you need the context
await client.execute((ctx) => fetch(url, { signal: ctx.signal }));
```

## Interaction with Retry

Retry is **outside** timeout. That combination means:

```text
retry
 └─ timeout (perAttemptMs)   ← fresh timer per attempt
     └─ operation
```

- Each attempt is independently bounded.
- The worst-case wall clock is roughly `maxAttempts × perAttemptMs` plus the retry delays, not
  `perAttemptMs` overall.
- `TimeoutError` is retryable under the default classifier, so a timed-out attempt triggers the next
  one.
- If every attempt times out, the caller sees `RetryExceededError` with
  `lastError instanceof TimeoutError`.

If you want a single overall bound, set a deadline on the context (`execute(..., { deadlineMs })`).
Do not pass `timeout.deadlineMs` — it throws. Or keep `maxAttempts: 1`.

## Events

`TimeoutTriggered` with `attemptNumber` and `timeoutMs`. No metrics are recorded.

## Example

```ts
import { createClient, RetryExceededError, TimeoutError } from "@resili/core";

const client = createClient(fetchUser, {
  timeout: { perAttemptMs: 800 },
  retry: { maxAttempts: 3, baseDelayMs: 100, jitter: "none" },
});

try {
  await client.call("42");
} catch (error) {
  if (error instanceof TimeoutError) {
    // single attempt, no retry configured
  }
  if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    // all three attempts timed out
  }
}
```

## Limitations

- `TimeoutOptions.deadlineMs` is rejected. Use `ContextInit.deadline` / `deadlineMs` for an
  overall bound.
- There is no connect-only, time-to-first-byte, or idle timeout. `perAttemptMs` covers the full
  attempt. For LLM streaming this includes time spent waiting for the consumer to pull — see
  [LLM timeouts](../llm/timeouts.md).
- Cancellation is cooperative. Work that ignores `ctx.signal` is abandoned, not killed.
