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

  it("rejects invalid options and deferred wait mode", () => {
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
