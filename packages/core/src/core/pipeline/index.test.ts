import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import type { Next, Policy, PolicyOrder } from "../policy";
import { compilePipeline, type Operation } from "./index";

afterEach(() => {
  vi.useRealTimers();
});

describe("compilePipeline", () => {
  it("executes an empty pipeline operation once", async () => {
    const operation = vi.fn<Operation<string>>(() => Promise.resolve("ok"));
    const pipeline = compilePipeline([]);

    await expect(pipeline.execute(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("executes policies in resolved order", async () => {
    const events: string[] = [];
    const pipeline = compilePipeline([
      recordingPolicy("third", 300, events),
      recordingPolicy("first", 100, events),
      recordingPolicy("second", 200, events),
    ]);

    await pipeline.execute(() => Promise.resolve("ok"));

    expect(events.filter((event) => event.startsWith("enter:"))).toEqual([
      "enter:first",
      "enter:second",
      "enter:third",
    ]);
  });

  it("unwinds policies in onion order", async () => {
    const events: string[] = [];
    const pipeline = compilePipeline([
      recordingPolicy("outer", 100, events),
      recordingPolicy("inner", 200, events),
    ]);

    await pipeline.execute(() => {
      events.push("operation");

      return Promise.resolve("ok");
    });

    expect(events).toEqual(["enter:outer", "enter:inner", "operation", "exit:inner", "exit:outer"]);
  });

  it("sorts numeric policy orders ascending", () => {
    const pipeline = compilePipeline([
      passThroughPolicy("three", 3),
      passThroughPolicy("one", 1),
      passThroughPolicy("two", 2),
    ]);

    expect(policyNames(pipeline.policies)).toEqual(["one", "two", "three"]);
  });

  it("sorts before and after anchors around the canonical built-in order", () => {
    const pipeline = compilePipeline([
      passThroughPolicy("retry", 200),
      passThroughPolicy("before-retry", { before: "retry" }),
      passThroughPolicy("after-retry", { after: "retry" }),
    ]);

    expect(policyNames(pipeline.policies)).toEqual(["before-retry", "retry", "after-retry"]);
  });

  it("sorts hedge between timeout and rate limiter in the built-in order", () => {
    const pipeline = compilePipeline([
      passThroughPolicy("rate-limiter", 500),
      passThroughPolicy("hedge", 450),
      passThroughPolicy("timeout", 400),
    ]);

    expect(policyNames(pipeline.policies)).toEqual(["timeout", "hedge", "rate-limiter"]);
  });

  it("supports relative anchors around hedge", () => {
    const pipeline = compilePipeline([
      passThroughPolicy("hedge", 450),
      passThroughPolicy("before-hedge", { before: "hedge" }),
      passThroughPolicy("after-hedge", { after: "hedge" }),
    ]);

    expect(policyNames(pipeline.policies)).toEqual(["before-hedge", "hedge", "after-hedge"]);
  });

  it("preserves original input order for equal resolved orders", () => {
    const pipeline = compilePipeline([
      passThroughPolicy("first", 100),
      passThroughPolicy("second", 100),
      passThroughPolicy("third", 100),
    ]);

    expect(policyNames(pipeline.policies)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the input policies array", () => {
    const policies = [
      passThroughPolicy("third", 300),
      passThroughPolicy("first", 100),
      passThroughPolicy("second", 200),
    ];

    compilePipeline(policies);

    expect(policyNames(policies)).toEqual(["third", "first", "second"]);
  });

  it("freezes pipeline policies", () => {
    const pipeline = compilePipeline([passThroughPolicy("policy", 100)]);

    expect(Object.isFrozen(pipeline.policies)).toBe(true);
    expect(() => {
      (pipeline.policies as Policy[]).push(passThroughPolicy("mutated", 200));
    }).toThrow(TypeError);
  });

  it("passes ContextInit to createContext", async () => {
    const operation = vi.fn<Operation<string>>((ctx) => {
      expect(ctx.requestId).toBe("request");
      expect(ctx.operationName).toBe("operation");
      expect(ctx.serviceName).toBe("service");
      expect(ctx.attemptNumber).toBe(3);
      expect(ctx.metadata.get("tenant")).toBe("acme");
      expect(ctx.startedAt).toBe(1_000);
      expect(ctx.deadline).toBe(2_000);

      return Promise.resolve("ok");
    });

    await compilePipeline([]).execute(operation, {
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      attemptNumber: 3,
      metadata: { tenant: "acme" },
      startedAt: 1_000,
      deadline: 2_000,
    });

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("releases context resources when the operation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const error = new Error("operation failed");

    await expect(
      compilePipeline([]).execute(() => Promise.reject(error), {
        deadline: 2_000,
      }),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases context resources when a policy fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const error = new Error("policy failed");
    const operation = vi.fn<Operation<string>>(() => Promise.resolve("ok"));

    await expect(
      compilePipeline([failingPolicy("failing", 100, error)]).execute(operation, {
        deadline: 2_000,
      }),
    ).rejects.toBe(error);
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows short-circuit policies to skip the operation", async () => {
    const operation = vi.fn<Operation<string>>(() => Promise.resolve("operation"));
    const pipeline = compilePipeline([shortCircuitPolicy("short-circuit", 100, "cached")]);

    await expect(pipeline.execute(operation)).resolves.toBe("cached");
    expect(operation).not.toHaveBeenCalled();
  });
});

function passThroughPolicy(name: string, order: PolicyOrder): Policy {
  return {
    name,
    order,
    execute<T>(ctx: Context, next: Next<T>): Promise<T> {
      return next(ctx);
    },
  };
}

function recordingPolicy(name: string, order: PolicyOrder, events: string[]): Policy {
  return {
    name,
    order,
    async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
      events.push(`enter:${name}`);

      try {
        return await next(ctx);
      } finally {
        events.push(`exit:${name}`);
      }
    },
  };
}

function failingPolicy(name: string, order: PolicyOrder, error: Error): Policy {
  return {
    name,
    order,
    execute(): Promise<never> {
      return Promise.reject(error);
    },
  };
}

function shortCircuitPolicy(name: string, order: PolicyOrder, value: string): Policy {
  return {
    name,
    order,
    execute<T>(): Promise<T> {
      return Promise.resolve(value as T);
    },
  };
}

function policyNames(policies: readonly Policy[]): string[] {
  return policies.map((policy) => policy.name);
}
