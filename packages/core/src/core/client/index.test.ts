import { describe, expect, it, vi } from "vitest";

import { createContext } from "../context";
import { DefaultEventBus, type ResiliEvent } from "../events";
import { compilePipeline, type Pipeline } from "../pipeline";
import { createCoreClient } from "./index";

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
