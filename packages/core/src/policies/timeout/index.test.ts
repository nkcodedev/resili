import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import type { Clock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError, TimeoutError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { timeoutPolicy } from "./index";

describe("timeoutPolicy", () => {
  it("creates an immutable policy from numeric shorthand", () => {
    const services = createServices();
    const policy = timeoutPolicy.create(services, 50);

    expect(policy.name).toBe("timeout");
    expect(policy.order).toBe(400);
    expect(Object.isFrozen(timeoutPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("allows object options with a valid deadline budget", async () => {
    const services = createServices();
    const policy = timeoutPolicy.create(services, { perAttemptMs: 50, deadlineMs: 100 });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
  });

  it("rejects invalid options", () => {
    const services = createServices();

    expect(() => timeoutPolicy.create(services)).toThrow(ConfigurationError);
    expect(() => timeoutPolicy.create(services, 0)).toThrow(ConfigurationError);
    expect(() => timeoutPolicy.create(services, Number.NaN)).toThrow(ConfigurationError);
    expect(() => timeoutPolicy.create(services, { perAttemptMs: -1 })).toThrow(ConfigurationError);
    expect(() => timeoutPolicy.create(services, { perAttemptMs: 100, deadlineMs: 50 })).toThrow(
      ConfigurationError,
    );
  });

  it("passes a forked child context to downstream work", async () => {
    const services = createServices();
    const policy = timeoutPolicy.create(services, 100);
    const parent = createTestContext();
    let childContext: Context | undefined;

    await policy.execute(parent, (ctx) => {
      childContext = ctx;

      return Promise.resolve("ok");
    });

    expect(childContext).toBeDefined();
    expect(childContext).not.toBe(parent);
    expect(childContext?.requestId).toBe(parent.requestId);
    expect(childContext?.operationName).toBe(parent.operationName);
    expect(childContext?.serviceName).toBe(parent.serviceName);
    expect(childContext?.attemptNumber).toBe(parent.attemptNumber);
    expect(parent.signal.aborted).toBe(false);
  });

  it("rejects with TimeoutError and emits TimeoutTriggered when the timer fires", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const services = createServices({ clock, emit });
    const policy = timeoutPolicy.create(services, 100);
    let childContext: Context | undefined;
    const result = policy.execute(createTestContext(), (ctx) => {
      childContext = ctx;

      return new Promise<string>(() => {
        // Intentionally never resolves.
      });
    });

    clock.tick(100);

    await expect(result).rejects.toMatchObject({
      code: "ERR_TIMEOUT",
      timeoutMs: 100,
      attemptNumber: 2,
    });
    expect(childContext?.signal.aborted).toBe(true);
    expect(childContext?.signal.reason).toBeInstanceOf(TimeoutError);
    expect(emit).toHaveBeenCalledWith({
      type: "TimeoutTriggered",
      timestamp: 100,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      attemptNumber: 2,
      timeoutMs: 100,
    });
  });

  it("clears the timer when downstream succeeds before timeout", async () => {
    const clock = new FakeClock();
    const services = createServices({ clock });
    const policy = timeoutPolicy.create(services, 100);

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );

    expect(clock.activeTimers).toBe(0);
    expect(clock.clearedTimers).toBe(1);
  });

  it("clears the timer when downstream fails before timeout", async () => {
    const clock = new FakeClock();
    const services = createServices({ clock });
    const policy = timeoutPolicy.create(services, 100);
    const failure = new Error("downstream failed");

    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(clock.activeTimers).toBe(0);
    expect(clock.clearedTimers).toBe(1);
  });

  it("preserves synchronous downstream failures before timeout", async () => {
    const clock = new FakeClock();
    const services = createServices({ clock });
    const policy = timeoutPolicy.create(services, 100);
    const failure = new Error("sync failed");
    const next: Next<string> = () => {
      throw failure;
    };

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(failure);

    expect(clock.activeTimers).toBe(0);
  });
});

function createTestContext(): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    attemptNumber: 2,
    startedAt: 0,
  });
}

function createServices(
  overrides: Partial<Pick<PolicyServices, "clock" | "emit">> = {},
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
    classifier: httpClassifier,
  });
}

class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  clearedTimers = 0;

  get activeTimers(): number {
    return this.#timers.size;
  }

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
