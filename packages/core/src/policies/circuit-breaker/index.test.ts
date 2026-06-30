import { describe, expect, it, vi } from "vitest";

import type { FailureClassifier, Outcome } from "../../core/classification";
import type { Clock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { CircuitOpenError, ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { circuitBreakerPolicy } from "./index";

describe("circuitBreakerPolicy", () => {
  it("creates an immutable policy with default options", () => {
    const policy = circuitBreakerPolicy.create(createServices());

    expect(policy.name).toBe("circuit-breaker");
    expect(policy.order).toBe(300);
    expect(Object.isFrozen(circuitBreakerPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects invalid options", () => {
    const services = createServices();

    expect(() => circuitBreakerPolicy.create(services, null)).toThrow(ConfigurationError);
    expect(() =>
      circuitBreakerPolicy.create(services, {
        window: { type: "count", size: 0 },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      circuitBreakerPolicy.create(services, {
        window: { type: "time", durationMs: 0 },
      }),
    ).toThrow(ConfigurationError);
    expect(() => circuitBreakerPolicy.create(services, { failureRateThreshold: 0 })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      circuitBreakerPolicy.create(services, {
        window: { type: "count", size: 2 },
        minimumThroughput: 3,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      circuitBreakerPolicy.create(services, {
        halfOpenMaxCalls: 1,
        successThreshold: 2,
      }),
    ).toThrow(ConfigurationError);
    expect(() => circuitBreakerPolicy.create(services, { slowCallRateThreshold: 50 })).toThrow(
      ConfigurationError,
    );
    expect(() => circuitBreakerPolicy.create(services, { key: "" })).toThrow(ConfigurationError);
  });

  it("passes calls while closed", async () => {
    const policy = circuitBreakerPolicy.create(createServices(), {
      minimumThroughput: 1,
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
  });

  it("opens after failure rate reaches threshold and fast-fails while open", async () => {
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const clock = new FakeClock();
    const policy = circuitBreakerPolicy.create(createServices({ clock, emit }), {
      window: { type: "count", size: 2 },
      minimumThroughput: 2,
      failureRateThreshold: 50,
      resetTimeoutMs: 1_000,
    });
    const failure = new Error("downstream failed");

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(emit).toHaveBeenCalledWith({
      type: "CircuitOpened",
      timestamp: 0,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
      failureRate: 50,
      resetAt: 1_000,
    });
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("blocked")),
    ).rejects.toMatchObject({
      code: "ERR_CIRCUIT_OPEN",
      key: "service",
      retryAfterMs: 1_000,
    });
  });

  it("does not open before minimum throughput", async () => {
    const policy = circuitBreakerPolicy.create(createServices(), {
      window: { type: "count", size: 10 },
      minimumThroughput: 3,
      failureRateThreshold: 50,
    });
    const failure = new Error("downstream failed");

    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("still closed")),
    ).resolves.toBe("still closed");
  });

  it("transitions from open to half-open and closes after successful probes", async () => {
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const clock = new FakeClock();
    const policy = circuitBreakerPolicy.create(createServices({ clock, emit }), {
      window: { type: "count", size: 1 },
      minimumThroughput: 1,
      failureRateThreshold: 100,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 2,
      successThreshold: 2,
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");

    clock.tick(100);

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("probe 1")),
    ).resolves.toBe("probe 1");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("probe 2")),
    ).resolves.toBe("probe 2");

    expect(emit).toHaveBeenCalledWith({
      type: "CircuitHalfOpened",
      timestamp: 100,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
      probesAllowed: 2,
    });
    expect(emit).toHaveBeenCalledWith({
      type: "CircuitClosed",
      timestamp: 100,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("closed")),
    ).resolves.toBe("closed");
  });

  it("limits concurrent half-open probes", async () => {
    const clock = new FakeClock();
    const policy = circuitBreakerPolicy.create(createServices({ clock }), {
      window: { type: "count", size: 1 },
      minimumThroughput: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
    });
    const gate = createGate();

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");

    clock.tick(100);

    const probe = policy.execute(createTestContext(), () => gate.promise);

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    gate.resolve("ok");
    await probe;
  });

  it("reopens on half-open failure", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = circuitBreakerPolicy.create(createServices({ clock, emit }), {
      window: { type: "count", size: 1 },
      minimumThroughput: 1,
      resetTimeoutMs: 100,
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");

    clock.tick(100);

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("probe failed"))),
    ).rejects.toThrow("probe failed");

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CircuitOpened",
        timestamp: 100,
      }),
    );
  });

  it("opens based on slow call rate", async () => {
    const clock = new FakeClock();
    const policy = circuitBreakerPolicy.create(createServices({ clock }), {
      window: { type: "count", size: 2 },
      minimumThroughput: 2,
      failureRateThreshold: 100,
      slowCallDurationMs: 50,
      slowCallRateThreshold: 50,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("fast"));
    const slow = policy.execute(createTestContext(), () => {
      clock.tick(50);

      return Promise.resolve("slow");
    });

    await expect(slow).resolves.toBe("slow");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("isolates breaker state by resolved key", async () => {
    const policy = circuitBreakerPolicy.create(createServices(), {
      window: { type: "count", size: 1 },
      minimumThroughput: 1,
      key: (ctx: Context) => String(ctx.metadata.get("key")),
    });

    await expect(
      policy.execute(createTestContext({ key: "a" }), () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    await expect(
      policy.execute(createTestContext({ key: "b" }), () => Promise.resolve("b")),
    ).resolves.toBe("b");
    await expect(
      policy.execute(createTestContext({ key: "a" }), () => Promise.resolve("a")),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("supports simple time windows", async () => {
    const clock = new FakeClock();
    const policy = circuitBreakerPolicy.create(createServices({ clock }), {
      window: { type: "time", durationMs: 100 },
      minimumThroughput: 2,
      failureRateThreshold: 50,
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("old failure"))),
    ).rejects.toThrow("old failure");

    clock.tick(101);

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("new success")),
    ).resolves.toBe("new success");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("still closed")),
    ).resolves.toBe("still closed");
  });

  it("validates keys resolved at execution time", async () => {
    const policy = circuitBreakerPolicy.create(createServices(), {
      key: () => "",
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).rejects.toThrow(
      ConfigurationError,
    );
  });
});

function createTestContext(metadata: Readonly<Record<string, unknown>> = {}): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    metadata,
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
    classifier: overrides.classifier ?? failureClassifier(),
  });
}

function failureClassifier(): FailureClassifier {
  return Object.freeze({
    isFailure(outcome: Outcome): boolean {
      return outcome.status === "error";
    },
    isRetryable(): boolean {
      return false;
    },
  });
}

function createGate<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

class FakeClock implements Clock {
  #now = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void): ReturnType<typeof globalThis.setTimeout> {
    return globalThis.setTimeout(callback, 0);
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    globalThis.clearTimeout(handle);
  }

  tick(ms: number): void {
    this.#now += ms;
  }
}
