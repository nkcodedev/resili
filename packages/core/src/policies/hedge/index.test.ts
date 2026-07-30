import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { systemClock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { hedgePolicy } from "./index";

describe("hedgePolicy", () => {
  it("creates an immutable policy from valid options", () => {
    const policy = hedgePolicy.create(createServices(), { delay: 50 });

    expect(hedgePolicy.name).toBe("hedge");
    expect(hedgePolicy.order).toBe(450);
    expect(policy.name).toBe("hedge");
    expect(policy.order).toBe(450);
    expect(Object.isFrozen(hedgePolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("passes through exactly once in the Phase 1 skeleton", async () => {
    const policy = hedgePolicy.create(createServices(), { delay: 50 });
    const ctx = createTestContext();
    const next = vi.fn<Next<string>>((nextCtx) => {
      expect(nextCtx).toBe(ctx);

      return Promise.resolve("ok");
    });

    await expect(policy.execute(ctx, next)).resolves.toBe("ok");

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("preserves downstream failures in the Phase 1 skeleton", async () => {
    const policy = hedgePolicy.create(createServices(), { delay: 50 });
    const failure = new Error("downstream failed");
    const next = vi.fn<Next<string>>(() => Promise.reject(failure));

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(failure);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts valid optional values", async () => {
    const shouldAccept = vi.fn<(value: string, ctx: Context) => boolean>(() => true);
    const policy = hedgePolicy.create(createServices(), {
      delay: 0,
      maxAttempts: 2,
      shouldAccept,
      abortLosers: false,
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
    expect(shouldAccept).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid delay options with field paths", () => {
    const services = createServices();

    expectConfigurationField(() => hedgePolicy.create(services), "hedge");
    expectConfigurationField(() => hedgePolicy.create(services, {}), "hedge.delay");
    expectConfigurationField(() => hedgePolicy.create(services, { delay: -1 }), "hedge.delay");
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: Number.NaN }),
      "hedge.delay",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: Number.POSITIVE_INFINITY }),
      "hedge.delay",
    );
    expectConfigurationField(() => hedgePolicy.create(services, { delay: "100" }), "hedge.delay");
  });

  it("rejects invalid optional values with field paths", () => {
    const services = createServices();

    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, maxAttempts: 1 }),
      "hedge.maxAttempts",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, maxAttempts: 3 }),
      "hedge.maxAttempts",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, shouldAccept: true }),
      "hedge.shouldAccept",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, abortLosers: "yes" }),
      "hedge.abortLosers",
    );
  });
});

function createServices(): PolicyServices {
  return Object.freeze({
    clock: systemClock,
    metrics: noopMetrics,
    emit(event: ResiliEvent): void {
      void event;
      // Hedge Phase 1 does not emit events.
    },
    store: memoryStore(),
    classifier: httpClassifier,
  });
}

function createTestContext(): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    startedAt: 0,
  });
}

function expectConfigurationField(action: () => unknown, field: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).field).toBe(field);
    return;
  }

  throw new Error("Expected ConfigurationError.");
}
