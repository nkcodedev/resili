/**
 * Terminal demo recorded for the README GIF.
 *
 * Same published @resili/core install as index.mjs. No API keys.
 * Failures are local throws. Delays come from the retry policy.
 *
 *   cd examples/stackblitz
 *   npm install
 *   node demo.mjs
 */
import { CircuitOpenError, resili } from "@resili/core";

let attempts = 0;
const recovered = resili(async () => {
  attempts += 1;

  if (attempts < 3) {
    const error = new Error(`transient failure ${attempts}`);
    console.log(`  attempt ${attempts} failed: ${error.message}`);
    throw error;
  }

  console.log(`  attempt ${attempts} succeeded`);
  return "recovered";
})
  .retry({
    maxAttempts: 3,
    backoff: "fixed",
    // The 2800 ms retry delays are intentionally exaggerated so the demonstration stays readable.
    baseDelayMs: 2_800,
    jitter: "none",
    retryOn(outcome) {
      return (
        outcome.status === "error" &&
        outcome.error instanceof Error &&
        outcome.error.message.startsWith("transient failure")
      );
    },
  })
  .build();

recovered.on("RetryStarted", (event) => {
  console.log(`  waiting ${event.delayMs}ms before attempt ${event.attemptNumber}`);
});

console.log("Retry");
const value = await recovered.call();
console.log(`  result: ${value} (${attempts} attempts)`);

let dependencyCalls = 0;
const guarded = resili(async () => {
  dependencyCalls += 1;
  console.log(`  dependency call ${dependencyCalls}: upstream is down`);
  throw new Error("upstream is down");
})
  .circuitBreaker({
    minimumThroughput: 1,
    failureRateThreshold: 50,
    resetTimeoutMs: 60_000,
  })
  .build();

console.log("Circuit breaker");

try {
  await guarded.call();
} catch (error) {
  console.log(`  call failed: ${error instanceof Error ? error.message : error}`);
}

try {
  await guarded.call();
} catch (error) {
  if (!(error instanceof CircuitOpenError)) {
    throw error;
  }

  console.log(`  next request blocked: ${error.code}`);
  console.log(`  dependency calls: ${dependencyCalls}`);
}

await recovered.destroy();
await guarded.destroy();
