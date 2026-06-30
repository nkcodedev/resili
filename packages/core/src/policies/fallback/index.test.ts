import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { systemClock } from "../../core/clock";
import { createContext, type Context } from "../../core/context";
import { ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { fallbackPolicy } from "./index";

describe("fallbackPolicy", () => {
  it("creates an immutable fallback policy", () => {
    const policy = fallbackPolicy.create(createServices(), {
      handler() {
        return "fallback";
      },
    });

    expect(policy.name).toBe("fallback");
    expect(policy.order).toBe(100);
    expect(Object.isFrozen(fallbackPolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects invalid options", () => {
    const services = createServices();

    expect(() => fallbackPolicy.create(services)).toThrow(ConfigurationError);
    expect(() => fallbackPolicy.create(services, null)).toThrow(ConfigurationError);
    expect(() => fallbackPolicy.create(services, [])).toThrow(ConfigurationError);
    expect(() => fallbackPolicy.create(services, {})).toThrow(ConfigurationError);
    expect(() => fallbackPolicy.create(services, { handler: "fallback" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      fallbackPolicy.create(services, {
        handler() {
          return "fallback";
        },
        fallbackOn: true,
      }),
    ).toThrow(ConfigurationError);
  });

  it("passes through downstream success without calling handler", async () => {
    const handler = vi.fn(() => "fallback");
    const policy = fallbackPolicy.create(createServices(), { handler });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handler with original error and context on downstream failure", async () => {
    const failure = new Error("failed");
    const ctx = createTestContext();
    const handler = vi.fn((error: unknown, handlerCtx: Context) => {
      expect(error).toBe(failure);
      expect(handlerCtx).toBe(ctx);

      return "fallback";
    });
    const policy = fallbackPolicy.create(createServices(), { handler });

    await expect(policy.execute(ctx, () => Promise.reject(failure))).resolves.toBe("fallback");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports async fallback handlers", async () => {
    const policy = fallbackPolicy.create(createServices(), {
      handler() {
        return Promise.resolve("async fallback");
      },
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("failed"))),
    ).resolves.toBe("async fallback");
  });

  it("rethrows original error when fallbackOn returns false", async () => {
    const failure = new Error("terminal");
    const handler = vi.fn(() => "fallback");
    const fallbackOn = vi.fn(() => false);
    const policy = fallbackPolicy.create(createServices(), { handler, fallbackOn });

    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(fallbackOn).toHaveBeenCalledWith(failure, expect.any(Object));
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles errors when fallbackOn returns true", async () => {
    const failure = new Error("handled");
    const fallbackOn = vi.fn(() => true);
    const policy = fallbackPolicy.create(createServices(), {
      fallbackOn,
      handler() {
        return "fallback";
      },
    });

    await expect(policy.execute(createTestContext(), () => Promise.reject(failure))).resolves.toBe(
      "fallback",
    );
    expect(fallbackOn).toHaveBeenCalledWith(failure, expect.any(Object));
  });

  it("propagates handler errors", async () => {
    const handlerError = new Error("handler failed");
    const policy = fallbackPolicy.create(createServices(), {
      handler() {
        throw handlerError;
      },
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.reject(new Error("downstream failed"))),
    ).rejects.toBe(handlerError);
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

function createServices(): PolicyServices {
  return Object.freeze({
    clock: systemClock,
    metrics: noopMetrics,
    emit(): void {
      // Test double.
    },
    store: memoryStore(),
    classifier: httpClassifier,
  });
}
