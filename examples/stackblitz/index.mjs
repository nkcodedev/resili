/**
 * Standalone example for a StackBlitz (or any npm) project.
 *
 * Installs published @resili/core. No API keys. Failures are local throws.
 */
import { CircuitOpenError, resili } from "@resili/core";

let attempts = 0;
const recovered = resili(async () => {
  attempts += 1;

  if (attempts < 3) {
    throw new Error(`transient failure ${attempts}`);
  }

  return "recovered";
})
  .retry({
    maxAttempts: 3,
    backoff: "fixed",
    baseDelayMs: 0,
    jitter: "none",
    // A plain Error is not retryable unless retryOn says so.
    retryOn(outcome) {
      return (
        outcome.status === "error" &&
        outcome.error instanceof Error &&
        outcome.error.message.startsWith("transient failure")
      );
    },
  })
  .build();

console.log("retry result:", await recovered.call());
console.log("attempts:", attempts);

let dependencyCalls = 0;
const guarded = resili(async () => {
  dependencyCalls += 1;
  throw new Error("upstream is down");
})
  .circuitBreaker({
    minimumThroughput: 1,
    failureRateThreshold: 50,
    resetTimeoutMs: 60_000,
  })
  .build();

try {
  await guarded.call();
} catch (error) {
  console.log("first call reached the dependency:", dependencyCalls);
  console.log("first error:", error instanceof Error ? error.message : error);
}

try {
  await guarded.call();
} catch (error) {
  if (!(error instanceof CircuitOpenError)) {
    throw error;
  }

  console.log("second call code:", error.code);
  console.log("dependency calls after the open circuit:", dependencyCalls);
}
