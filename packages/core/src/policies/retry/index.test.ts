import { describe, expect, it, vi } from "vitest";

import type { FailureClassifier, Outcome } from "../../core/classification";
import type { Clock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError, RateLimitExceededError, RetryExceededError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { retryPolicy } from "./index";

describe("retryPolicy", () => {
  it("creates an immutable retry policy", () => {
    const policy = retryPolicy.create(createServices(), {
      maxAttempts: 1,
      jitter: "none",
    });

    expect(policy.name).toBe("retry");
    expect(policy.order).toBe(200);
    expect(Object.isFrozen(retryPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects invalid and deferred options", () => {
    const services = createServices();

    expect(() => retryPolicy.create(services, null)).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { maxAttempts: 0 })).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { baseDelayMs: -1 })).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { baseDelayMs: 10, maxDelayMs: 5 })).toThrow(
      ConfigurationError,
    );
    expect(() => retryPolicy.create(services, { maxTotalDelayMs: -1 })).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { backoff: "fixed", factor: 2 })).toThrow(
      ConfigurationError,
    );
    expect(() => retryPolicy.create(services, { jitter: "full" })).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { jitter: "equal" })).toThrow(ConfigurationError);
    expect(() => retryPolicy.create(services, { idempotentOnly: true })).toThrow(
      ConfigurationError,
    );
    expect(() => retryPolicy.create(services, { retryOn: true })).toThrow(ConfigurationError);
  });

  it("succeeds on the first attempt without retrying", async () => {
    const next = vi.fn(() => Promise.resolve("ok"));
    const policy = retryPolicy.create(createServices(), {
      maxAttempts: 3,
      jitter: "none",
    });

    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok");

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failures until success", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = retryPolicy.create(createServices({ clock, emit }), {
      maxAttempts: 3,
      backoff: "fixed",
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitter: "none",
    });
    const attempts: number[] = [];
    const result = policy.execute(createTestContext(), (ctx) => {
      attempts.push(ctx.attemptNumber);

      return attempts.length < 3 ? Promise.reject(new Error("retryable")) : Promise.resolve("ok");
    });

    await advanceRetryDelay(clock, 50);
    await advanceRetryDelay(clock, 50);

    await expect(result).resolves.toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryStarted", attemptNumber: 2, delayMs: 50 }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryCompleted", attempts: 3, totalDelayMs: 100 }),
    );
  });

  it("does not retry non-retryable outcomes", async () => {
    const classifier = createClassifier({
      retryable: false,
    });
    const policy = retryPolicy.create(createServices({ classifier }), {
      maxAttempts: 3,
      jitter: "none",
    });
    const failure = new Error("terminal");
    const next = vi.fn(() => Promise.reject(failure));

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(failure);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("uses retryOn predicate when provided", async () => {
    const clock = new FakeClock();
    const retryOn = vi.fn((outcome: Outcome) => outcome.status === "error");
    const policy = retryPolicy.create(
      createServices({ clock, classifier: createClassifier({ retryable: false }) }),
      {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 10,
        jitter: "none",
        retryOn,
      },
    );
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve("ok");
    });

    await advanceRetryDelay(clock, 10);

    await expect(result).resolves.toBe("ok");
    expect(retryOn).toHaveBeenCalled();
    expect(calls).toBe(2);
  });

  it("applies exponential backoff and max delay cap", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = retryPolicy.create(createServices({ clock, emit }), {
      maxAttempts: 4,
      backoff: "exponential",
      baseDelayMs: 10,
      maxDelayMs: 15,
      factor: 2,
      jitter: "none",
    });
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls < 4 ? Promise.reject(new Error("retryable")) : Promise.resolve("ok");
    });

    await advanceRetryDelay(clock, 10);
    await advanceRetryDelay(clock, 15);
    await advanceRetryDelay(clock, 15);

    await expect(result).resolves.toBe("ok");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryStarted", attemptNumber: 2, delayMs: 10 }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryStarted", attemptNumber: 3, delayMs: 15 }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryStarted", attemptNumber: 4, delayMs: 15 }),
    );
  });

  it("respects classifier retryAfter when enabled", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const classifier = createClassifier({ retryAfterMs: 75 });
    const policy = retryPolicy.create(createServices({ clock, emit, classifier }), {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: "none",
    });
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1
        ? Promise.reject(new RateLimitExceededError({ retryAfterMs: 75 }))
        : Promise.resolve("ok");
    });

    await advanceRetryDelay(clock, 75);

    await expect(result).resolves.toBe("ok");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryStarted", attemptNumber: 2, delayMs: 75 }),
    );
  });

  it("stops retrying when maxAttempts is exhausted", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = retryPolicy.create(createServices({ clock, emit }), {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitter: "none",
    });
    const result = policy.execute(createTestContext(), () =>
      Promise.reject(new Error("retryable")),
    );

    await advanceRetryDelay(clock, 10);

    await expect(result).rejects.toBeInstanceOf(RetryExceededError);
    await expect(result).rejects.toMatchObject({
      attempts: 2,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RetryFailed", attempts: 2 }),
    );
  });

  it("stops retrying when total delay budget would be exceeded", async () => {
    const clock = new FakeClock();
    const policy = retryPolicy.create(createServices({ clock }), {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 10,
      maxTotalDelayMs: 5,
      jitter: "none",
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("retryable"))),
    ).rejects.toMatchObject({
      attempts: 1,
    });
  });
});

function createTestContext(): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    startedAt: 0,
  });
}

function createServices(
  overrides: Partial<Pick<PolicyServices, "clock" | "emit" | "classifier">> = {},
): PolicyServices {
  return Object.freeze({
    clock: overrides.clock ?? new FakeClock(),
    metrics: noopMetrics,
    emit:
      overrides.emit ??
      (() => {
        // Test double.
      }),
    store: memoryStore(),
    classifier: overrides.classifier ?? createClassifier(),
  });
}

function createClassifier(
  options: { readonly retryable?: boolean; readonly retryAfterMs?: number } = {},
): FailureClassifier {
  return Object.freeze({
    isFailure(outcome: Outcome): boolean {
      return outcome.status === "error";
    },
    isRetryable(outcome: Outcome): boolean {
      return outcome.status === "error" && (options.retryable ?? true);
    },
    retryAfter(): number | undefined {
      return options.retryAfterMs;
    },
  });
}

async function advanceRetryDelay(clock: FakeClock, ms: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  clock.tick(ms);
  await Promise.resolve();
}

class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  clearedTimers = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
    const handle = this.#nextHandle++;

    this.#timers.set(handle, {
      at: this.#now + ms,
      callback,
    });

    return handle;
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    if (this.#timers.delete(handle as number)) {
      this.clearedTimers += 1;
    }
  }

  tick(ms: number): void {
    this.#now += ms;

    for (const [handle, timer] of [...this.#timers].sort(
      ([leftHandle], [rightHandle]) => leftHandle - rightHandle,
    )) {
      if (timer.at <= this.#now && this.#timers.delete(handle)) {
        timer.callback();
      }
    }
  }
}
