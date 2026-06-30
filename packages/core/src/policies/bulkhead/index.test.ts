import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import type { Clock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { BulkheadRejectedError, ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { bulkheadPolicy } from "./index";

describe("bulkheadPolicy", () => {
  it("creates an immutable policy from numeric shorthand", () => {
    const policy = bulkheadPolicy.create(createServices(), 2);

    expect(policy.name).toBe("bulkhead");
    expect(policy.order).toBe(600);
    expect(Object.isFrozen(bulkheadPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects invalid options", () => {
    const services = createServices();

    expect(() => bulkheadPolicy.create(services)).toThrow(ConfigurationError);
    expect(() => bulkheadPolicy.create(services, 0)).toThrow(ConfigurationError);
    expect(() => bulkheadPolicy.create(services, 1.5)).toThrow(ConfigurationError);
    expect(() => bulkheadPolicy.create(services, { maxConcurrent: 0 })).toThrow(ConfigurationError);
    expect(() => bulkheadPolicy.create(services, { maxConcurrent: 1, maxQueue: -1 })).toThrow(
      ConfigurationError,
    );
    expect(() => bulkheadPolicy.create(services, { maxConcurrent: 1, queueTimeoutMs: -1 })).toThrow(
      ConfigurationError,
    );
    expect(() => bulkheadPolicy.create(services, { maxConcurrent: 1, queueTimeoutMs: 10 })).toThrow(
      ConfigurationError,
    );
    expect(() => bulkheadPolicy.create(services, { maxConcurrent: 1, key: "" })).toThrow(
      ConfigurationError,
    );
  });

  it("allows up to maxConcurrent operations", async () => {
    const policy = bulkheadPolicy.create(createServices(), 2);
    const first = createGate();
    const second = createGate();
    const firstCall = policy.execute(createTestContext(), () => first.promise);
    const secondCall = policy.execute(createTestContext(), () => second.promise);

    first.resolve("first");
    second.resolve("second");

    await expect(firstCall).resolves.toBe("first");
    await expect(secondCall).resolves.toBe("second");
  });

  it("rejects immediately when full and queue is disabled", async () => {
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const clock = new FakeClock();
    const policy = bulkheadPolicy.create(createServices({ clock, emit }), 1);
    const gate = createGate();
    const active = policy.execute(createTestContext(), () => gate.promise);

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(BulkheadRejectedError);

    expect(emit).toHaveBeenCalledWith({
      type: "BulkheadRejected",
      timestamp: 0,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
      maxConcurrent: 1,
      queueSize: 0,
      waitedMs: 0,
    });

    gate.resolve("done");
    await active;
  });

  it("releases permits after downstream success and failure", async () => {
    const policy = bulkheadPolicy.create(createServices(), 1);
    const failure = new Error("failed");

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    await expect(policy.execute(createTestContext(), () => Promise.resolve("after"))).resolves.toBe(
      "after",
    );
  });

  it("isolates concurrency per resolved key", async () => {
    const policy = bulkheadPolicy.create(createServices(), {
      maxConcurrent: 1,
      key: (ctx: Context) => String(ctx.metadata.get("key")),
    });
    const first = createGate();
    const second = createGate();
    const firstCall = policy.execute(createTestContext({ key: "a" }), () => first.promise);
    const secondCall = policy.execute(createTestContext({ key: "b" }), () => second.promise);

    first.resolve("a");
    second.resolve("b");

    await expect(firstCall).resolves.toBe("a");
    await expect(secondCall).resolves.toBe("b");
  });

  it("queues requests in FIFO order", async () => {
    const policy = bulkheadPolicy.create(createServices(), { maxConcurrent: 1, maxQueue: 2 });
    const events: string[] = [];
    const first = createGate();
    const second = createGate();
    const third = createGate();
    const firstCall = policy.execute(createTestContext(), async () => {
      events.push("first:start");

      return first.promise;
    });
    const secondCall = policy.execute(createTestContext(), async () => {
      events.push("second:start");

      return second.promise;
    });
    const thirdCall = policy.execute(createTestContext(), async () => {
      events.push("third:start");

      return third.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    first.resolve("first");
    await expect(firstCall).resolves.toBe("first");
    await Promise.resolve();
    expect(events).toEqual(["first:start", "second:start"]);

    second.resolve("second");
    await expect(secondCall).resolves.toBe("second");
    await Promise.resolve();
    expect(events).toEqual(["first:start", "second:start", "third:start"]);

    third.resolve("third");
    await expect(thirdCall).resolves.toBe("third");
  });

  it("rejects when the queue is full", async () => {
    const policy = bulkheadPolicy.create(createServices(), { maxConcurrent: 1, maxQueue: 1 });
    const gate = createGate();
    const active = policy.execute(createTestContext(), () => gate.promise);

    void policy.execute(createTestContext(), () => Promise.resolve("queued"));

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("full")),
    ).rejects.toMatchObject({
      code: "ERR_BULKHEAD_FULL",
      maxConcurrent: 1,
      queueSize: 1,
      waitedMs: 0,
    });

    gate.resolve("done");
    await active;
  });

  it("rejects timed-out queued requests and removes them from the queue", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = bulkheadPolicy.create(createServices({ clock, emit }), {
      maxConcurrent: 1,
      maxQueue: 2,
      queueTimeoutMs: 50,
    });
    const first = createGate();
    const third = createGate();
    const active = policy.execute(createTestContext(), () => first.promise);
    const timedOut = policy.execute(createTestContext(), () => Promise.resolve("timed out"));
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      code: "ERR_BULKHEAD_FULL",
      maxConcurrent: 1,
      queueSize: 1,
      waitedMs: 50,
    });

    clock.tick(25);

    const thirdCall = policy.execute(createTestContext(), () => third.promise);

    clock.tick(25);

    await timedOutExpectation;
    expect(clock.activeTimers).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      type: "BulkheadRejected",
      timestamp: 50,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
      maxConcurrent: 1,
      queueSize: 1,
      waitedMs: 50,
    });

    first.resolve("first");
    await active;
    await Promise.resolve();

    third.resolve("third");
    await expect(thirdCall).resolves.toBe("third");
    expect(clock.activeTimers).toBe(0);
    expect(clock.clearedTimers).toBe(1);
  });

  it("uses a static key option", async () => {
    const policy = bulkheadPolicy.create(createServices(), { maxConcurrent: 1, key: "shared" });
    const gate = createGate();
    const active = policy.execute(createTestContext({ key: "a" }), () => gate.promise);

    await expect(
      policy.execute(createTestContext({ key: "b" }), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(BulkheadRejectedError);

    gate.resolve("done");
    await active;
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

void (undefined as unknown as Next<unknown>);
