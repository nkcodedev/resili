import { describe, expect, it, vi } from "vitest";

import { createContext } from "../context";
import { DefaultEventBus, type ResiliEvent } from "../events";
import { compilePipeline, type Pipeline } from "../pipeline";
import { createCoreClient, type ClientHealth, type ClientStats } from "./index";

describe("createCoreClient", () => {
  it("calls the wrapped operation through the pipeline", async () => {
    const operation = vi.fn<(id: string) => Promise<string>>((id) => Promise.resolve(`user:${id}`));
    const policyEvents: string[] = [];
    const client = createCoreClient({
      operation,
      pipeline: compilePipeline([
        {
          name: "observer",
          order: 100,
          async execute(ctx, next) {
            policyEvents.push(ctx.operationName);

            return next(ctx);
          },
        },
      ]),
    });

    await expect(client.call("42")).resolves.toBe("user:42");
    expect(operation).toHaveBeenCalledWith("42");
    expect(policyEvents).toEqual(["operation"]);
  });

  it("executes context-aware operations with ContextInit", async () => {
    const client = createCoreClient({
      operation: () => Promise.resolve("unused"),
      pipeline: compilePipeline([]),
    });

    await expect(
      client.execute(
        (ctx) =>
          Promise.resolve({
            operationName: ctx.operationName,
            serviceName: ctx.serviceName,
            tenant: ctx.metadata.get("tenant"),
          }),
        {
          operationName: "getUser",
          serviceName: "users",
          metadata: { tenant: "acme" },
        },
      ),
    ).resolves.toEqual({
      operationName: "getUser",
      serviceName: "users",
      tenant: "acme",
    });
  });

  it("tracks success and failure totals", async () => {
    const failure = new Error("failed");
    const client = createCoreClient({
      operation: (shouldFail: boolean): Promise<string> =>
        shouldFail ? Promise.reject(failure) : Promise.resolve("ok"),
      pipeline: compilePipeline([]),
    });

    await expect(client.call(false)).resolves.toBe("ok");
    await expect(client.call(true)).rejects.toBe(failure);

    expect(client.stats().totals).toEqual({
      calls: 2,
      successes: 1,
      failures: 1,
      retries: 0,
    });
  });

  it("returns immutable stats snapshots", async () => {
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
    });

    await client.call();

    const stats = client.stats();

    expect(Object.isFrozen(stats)).toBe(true);
    expect(Object.isFrozen(stats.totals)).toBe(true);
    expect(() => {
      (stats.totals as { calls: number }).calls = 99;
    }).toThrow(TypeError);
    expect(client.stats().totals.calls).toBe(1);
  });

  it("reports healthy when no circuits are open", () => {
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
    });

    expect(client.health()).toEqual({
      status: "healthy",
      openCircuits: [],
      details: client.stats(),
    });
  });

  it("reports unhealthy when any circuit is open", () => {
    const stats = createStats({
      circuit: {
        users: { state: "closed", failureRate: 0, calls: 10 },
        billing: { state: "open", failureRate: 1, calls: 5 },
      },
    });

    expect(createHealth(stats)).toEqual({
      status: "unhealthy",
      openCircuits: ["billing"],
      details: stats,
    });
  });

  it("reports degraded when any circuit is half-open", () => {
    const stats = createStats({
      circuit: {
        users: { state: "half_open", failureRate: 0.5, calls: 10 },
      },
    });

    expect(createHealth(stats)).toEqual({
      status: "degraded",
      openCircuits: [],
      details: stats,
    });
  });

  it("reports degraded when any bulkhead has queued work", () => {
    const stats = createStats({
      bulkhead: {
        users: { active: 2, queued: 1 },
      },
    });

    expect(createHealth(stats)).toEqual({
      status: "degraded",
      openCircuits: [],
      details: stats,
    });
  });

  it("reports healthy when circuits are closed and bulkheads are not queued", () => {
    const stats = createStats({
      circuit: {
        users: { state: "closed", failureRate: 0, calls: 10 },
      },
      bulkhead: {
        users: { active: 2, queued: 0 },
      },
    });

    expect(createHealth(stats)).toEqual({
      status: "healthy",
      openCircuits: [],
      details: stats,
    });
  });

  it("subscribes to events and clears default listeners on destroy", async () => {
    const events = new DefaultEventBus();
    const handler = vi.fn();
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
      events,
    });
    const event = createRequestStartedEvent();

    client.on("RequestStarted", handler);
    events.emit(event);

    await client.destroy();
    await client.destroy();
    events.emit(event);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs client disposer once during destroy", async () => {
    const dispose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
      dispose,
    });

    await client.destroy();
    await client.destroy();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects destroy when the client disposer fails", async () => {
    const failure = new Error("dispose failed");
    const events = new DefaultEventBus();
    const handler = vi.fn();
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
      events,
      dispose() {
        throw failure;
      },
    });

    client.on("RequestStarted", handler);

    await expect(client.destroy()).rejects.toBe(failure);
    events.emit(createRequestStartedEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it("allows subscriptions to be removed without destroying the client", () => {
    const events = new DefaultEventBus();
    const handler = vi.fn();
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
      events,
    });
    const unsubscribe = client.on("RequestStarted", handler);

    unsubscribe();
    events.emit(createRequestStartedEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves errors thrown by the pipeline", async () => {
    const failure = new Error("pipeline failed");
    const client = createCoreClient({
      operation: () => Promise.resolve("unused"),
      pipeline: failingPipeline(failure),
    });

    await expect(client.call()).rejects.toBe(failure);
    expect(client.stats().totals.failures).toBe(1);
  });
});

function failingPipeline(error: Error): Pipeline {
  return {
    policies: Object.freeze([]),
    execute<T>(): Promise<T> {
      return Promise.reject(error);
    },
  };
}

function createStats(
  patch: Partial<Pick<ClientStats, "circuit" | "bulkhead" | "rateLimiter">>,
): ClientStats {
  return Object.freeze({
    circuit: Object.freeze({ ...(patch.circuit ?? {}) }),
    bulkhead: Object.freeze({ ...(patch.bulkhead ?? {}) }),
    rateLimiter: Object.freeze({ ...(patch.rateLimiter ?? {}) }),
    totals: Object.freeze({
      calls: 0,
      successes: 0,
      failures: 0,
      retries: 0,
    }),
  });
}

function createHealth(stats: ClientStats): ClientHealth {
  const client = createCoreClient({
    operation: () => Promise.resolve("ok"),
    pipeline: compilePipeline([]),
  });
  const prototype = Object.getPrototypeOf(client) as {
    health(this: { stats(): ClientStats }): ClientHealth;
  };

  return prototype.health.call({ stats: () => stats });
}

function createRequestStartedEvent(): ResiliEvent {
  const ctx = createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    startedAt: 1,
  });

  return {
    type: "RequestStarted",
    timestamp: 1,
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    deadline: ctx.deadline,
  };
}
