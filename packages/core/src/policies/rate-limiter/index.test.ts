import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import type { Clock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError, RateLimitExceededError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { rateLimiterPolicy } from "./index";

describe("rateLimiterPolicy", () => {
  it("creates an immutable token-bucket policy", () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      limit: 2,
      intervalMs: 100,
    });

    expect(policy.name).toBe("rate-limiter");
    expect(policy.order).toBe(500);
    expect(Object.isFrozen(rateLimiterPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects invalid options", () => {
    const services = createServices();

    expect(() => rateLimiterPolicy.create(services)).toThrow(ConfigurationError);
    expect(() => rateLimiterPolicy.create(services, { limit: 0, intervalMs: 100 })).toThrow(
      ConfigurationError,
    );
    expect(() => rateLimiterPolicy.create(services, { limit: 1, intervalMs: 0 })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      rateLimiterPolicy.create(services, { strategy: "unknown", limit: 1, intervalMs: 100 }),
    ).toThrow(ConfigurationError);
    expect(() =>
      rateLimiterPolicy.create(services, {
        strategy: "sliding-window",
        limit: 1,
        intervalMs: 100,
        burst: 2,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      rateLimiterPolicy.create(services, { limit: 1, intervalMs: 100, maxWaitMs: 10 }),
    ).toThrow(ConfigurationError);
    expect(() =>
      rateLimiterPolicy.create(services, { limit: 1, intervalMs: 100, onLimit: "wait" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      rateLimiterPolicy.create(services, { limit: 1, intervalMs: 100, key: "" }),
    ).toThrow(ConfigurationError);
  });

  it("creates wait-mode policies when maxWaitMs is provided", () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      limit: 1,
      intervalMs: 100,
      onLimit: "wait",
      maxWaitMs: 50,
    });

    expect(policy.name).toBe("rate-limiter");
  });

  it("allows token-bucket requests up to burst and rejects after depletion", async () => {
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const clock = new FakeClock();
    const policy = rateLimiterPolicy.create(createServices({ clock, emit }), {
      limit: 2,
      intervalMs: 100,
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("first"))).resolves.toBe(
      "first",
    );
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("second")),
    ).resolves.toBe("second");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("third")),
    ).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
      retryAfterMs: 50,
    });
    expect(emit).toHaveBeenCalledWith({
      type: "RateLimited",
      timestamp: 0,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      key: "service",
      strategy: "token-bucket",
      retryAfterMs: 50,
      waited: false,
    });
  });

  it("refills token-bucket permits with injected clock time", async () => {
    const clock = new FakeClock();
    const policy = rateLimiterPolicy.create(createServices({ clock }), {
      limit: 2,
      intervalMs: 100,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    await policy.execute(createTestContext(), () => Promise.resolve("second"));

    clock.tick(50);

    await expect(policy.execute(createTestContext(), () => Promise.resolve("third"))).resolves.toBe(
      "third",
    );
  });

  it("uses explicit token-bucket burst capacity", async () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      strategy: "token-bucket",
      limit: 1,
      intervalMs: 100,
      burst: 3,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    await policy.execute(createTestContext(), () => Promise.resolve("second"));
    await policy.execute(createTestContext(), () => Promise.resolve("third"));

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("fourth")),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("enforces sliding-window limits per interval", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = rateLimiterPolicy.create(createServices({ clock, emit }), {
      strategy: "sliding-window",
      limit: 2,
      intervalMs: 100,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    clock.tick(10);
    await policy.execute(createTestContext(), () => Promise.resolve("second"));

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("third")),
    ).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
      retryAfterMs: 90,
    });

    clock.tick(90);

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("fourth")),
    ).resolves.toBe("fourth");
  });

  it("isolates limits by resolved key", async () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      limit: 1,
      intervalMs: 100,
      key: (ctx: Context) => String(ctx.metadata.get("key")),
    });

    await expect(
      policy.execute(createTestContext({ key: "a" }), () => Promise.resolve("a")),
    ).resolves.toBe("a");
    await expect(
      policy.execute(createTestContext({ key: "b" }), () => Promise.resolve("b")),
    ).resolves.toBe("b");
    await expect(
      policy.execute(createTestContext({ key: "a" }), () => Promise.resolve("blocked")),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("uses static key option", async () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      limit: 1,
      intervalMs: 100,
      key: "shared",
    });

    await policy.execute(createTestContext({ key: "a" }), () => Promise.resolve("first"));

    await expect(
      policy.execute(createTestContext({ key: "b" }), () => Promise.resolve("second")),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("validates keys resolved at execution time", async () => {
    const policy = rateLimiterPolicy.create(createServices(), {
      limit: 1,
      intervalMs: 100,
      key: () => "",
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).rejects.toThrow(
      ConfigurationError,
    );
  });

  it("waits for token-bucket capacity within maxWaitMs", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = rateLimiterPolicy.create(createServices({ clock, emit }), {
      limit: 1,
      intervalMs: 100,
      onLimit: "wait",
      maxWaitMs: 100,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    const waiting = policy.execute(createTestContext(), () => Promise.resolve("second"));
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "RateLimited",
        waited: false,
        retryAfterMs: 100,
      }),
    );

    clock.tick(100);
    await expect(waiting).resolves.toBe("second");
    expect(clock.activeTimers).toBe(0);
  });

  it("rejects immediately when required wait exceeds maxWaitMs", async () => {
    const clock = new FakeClock();
    const emit = vi.fn<(event: ResiliEvent) => void>();
    const policy = rateLimiterPolicy.create(createServices({ clock, emit }), {
      limit: 1,
      intervalMs: 100,
      onLimit: "wait",
      maxWaitMs: 40,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("second")),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "RateLimited",
        waited: false,
      }),
    );
    expect(clock.activeTimers).toBe(0);
  });

  it("aborts wait mode without consuming a token", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const policy = rateLimiterPolicy.create(createServices({ clock }), {
      limit: 1,
      intervalMs: 100,
      onLimit: "wait",
      maxWaitMs: 100,
    });

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    const waiting = policy.execute(createTestContext({}, controller.signal), () =>
      Promise.resolve("second"),
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Error);
    expect(clock.activeTimers).toBe(0);

    clock.tick(100);
    await expect(policy.execute(createTestContext(), () => Promise.resolve("third"))).resolves.toBe(
      "third",
    );
  });

  it("admits concurrent waiters in FIFO order", async () => {
    const clock = new FakeClock();
    const policy = rateLimiterPolicy.create(createServices({ clock }), {
      limit: 1,
      intervalMs: 50,
      onLimit: "wait",
      maxWaitMs: 200,
    });
    const order: string[] = [];

    await policy.execute(createTestContext(), () => Promise.resolve("first"));
    const second = policy.execute(createTestContext(), () => {
      order.push("second");

      return Promise.resolve("second");
    });
    const third = policy.execute(createTestContext(), () => {
      order.push("third");

      return Promise.resolve("third");
    });

    await Promise.resolve();
    await Promise.resolve();
    clock.tick(50);
    await expect(second).resolves.toBe("second");
    clock.tick(50);
    await expect(third).resolves.toBe("third");
    expect(order).toEqual(["second", "third"]);
    expect(clock.activeTimers).toBe(0);
  });
});

function createTestContext(
  metadata: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    metadata,
    ...(signal === undefined ? {} : { signal }),
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
    this.#timers.delete(handle as number);
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
