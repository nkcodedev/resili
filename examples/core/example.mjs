/**
 * Runnable locally. Not executed in CI.
 *
 * No credentials and no network access required — the "dependency" is a local
 * function that fails the first two times it is called.
 */
import { RetryExceededError, createClient, resili } from "@resili/core";

let attempts = 0;

async function flakyLookup(id) {
  attempts += 1;

  if (attempts < 3) {
    throw new Error(`transient failure on attempt ${attempts}`);
  }

  return { id, name: "Ada Lovelace" };
}

// 1. Declarative configuration.
const client = createClient(flakyLookup, {
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 50, jitter: "none" },
  // failureRateThreshold is a PERCENTAGE: 50 means half the calls in the window.
  circuitBreaker: { minimumThroughput: 10, failureRateThreshold: 50 },
});

client.on("RetryStarted", (event) => {
  console.log(`retrying, next attempt ${event.attemptNumber}`);
});

client.on("RequestCompleted", (event) => {
  console.log(`completed as ${event.status} after ${event.attempts} attempt(s)`);
});

console.log("declarative:", await client.call("42"));

// 2. The same policies through the fluent builder, plus a fallback so the
//    caller always gets a value.
attempts = 0;

const withFallback = resili(async () => {
  throw new Error("dependency is down");
})
  .timeout({ perAttemptMs: 1_000 })
  .retry({ maxAttempts: 2, jitter: "none" })
  .fallback({
    handler(error) {
      const cause = error instanceof RetryExceededError ? error.lastError : error;
      console.log("falling back because:", cause instanceof Error ? cause.message : cause);
      return { id: "42", name: "cached value" };
    },
  })
  .build();

console.log("with fallback:", await withFallback.call());

// 3. Caller cancellation. AbortSignal is the only cancellation mechanism, and
//    the operation receives it through the execution context.
const cancellable = resili(() => undefined).build();
const controller = new AbortController();

setTimeout(() => {
  controller.abort();
}, 100);

try {
  await cancellable.execute(
    (ctx) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve("finished");
        }, 5_000);

        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(ctx.signal.reason ?? new Error("aborted"));
        });
      }),
    { signal: controller.signal },
  );
} catch (error) {
  console.log("cancelled:", error instanceof Error ? error.message : error);
}

await client.destroy();
await withFallback.destroy();
await cancellable.destroy();
