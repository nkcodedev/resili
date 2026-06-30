import { describe, expect, it, vi } from "vitest";

import { httpClassifier, type FailureClassifier } from "../classification";
import { systemClock, type Clock } from "../clock";
import { createContext, type Context } from "../context";
import type { ResiliEvent } from "../events";
import { ConfigurationError } from "../errors";
import { noopMetrics } from "../metrics";
import { definePolicy, type Next, type PolicyFactory, type PolicyServices } from "../policy";
import { memoryStore, type StateStore } from "../state";
import { createBuilder, type Builder } from "./index";

describe("createBuilder", () => {
  it("builds a client that executes the wrapped operation once", async () => {
    const operation = vi.fn<(id: string) => Promise<string>>((id) => Promise.resolve(`user:${id}`));
    const client = createBuilder(operation).build();

    await expect(client.call("42")).resolves.toBe("user:42");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith("42");
  });

  it("is immutable and chainable without mutating previous snapshots", async () => {
    const events: string[] = [];
    const builder = createBuilder(() => Promise.resolve("ok"));
    const nextBuilder = builder.policy(observerFactory("observer", 100, events));

    expect(Object.isFrozen(builder)).toBe(true);
    expect(Object.isFrozen(nextBuilder)).toBe(true);
    expect(nextBuilder).not.toBe(builder);

    await builder.build().call();
    await nextBuilder.build().call();

    expect(events).toEqual(["observer:before", "observer:after"]);
  });

  it("creates policies from factories with services and options", async () => {
    const store = memoryStore();
    const clock = createClock();
    const classifier = createClassifier();
    const create = vi.fn<PolicyFactory["create"]>((services, options) => ({
      name: "capture",
      order: 100,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        expect(services).toMatchObject({
          clock,
          metrics: noopMetrics,
          store,
          classifier,
        });
        expect(options).toEqual({ enabled: true });

        return next(ctx);
      },
    }));
    const factory = definePolicy({
      name: "capture",
      order: 100,
      create,
    });
    const client = createBuilder(() => Promise.resolve("ok"))
      .withStore(store)
      .withClock(clock)
      .withClassifier(classifier)
      .policy(factory, { enabled: true })
      .build();

    await expect(client.call()).resolves.toBe("ok");

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses verified defaults for policy services", async () => {
    let capturedServices: PolicyServices | undefined;
    const factory = definePolicy({
      name: "defaults",
      order: 100,
      create(services) {
        capturedServices = services;

        return passThroughPolicy("defaults", 100);
      },
    });

    await createBuilder(() => Promise.resolve("ok"))
      .policy(factory)
      .build()
      .call();

    expect(capturedServices).toMatchObject({
      clock: systemClock,
      metrics: noopMetrics,
      classifier: httpClassifier,
    });
    expect(capturedServices?.store).toBeDefined();
  });

  it("compiles custom policies through deterministic pipeline ordering", async () => {
    const events: string[] = [];
    const client = createBuilder(() => Promise.resolve("ok"))
      .policy(observerFactory("late", 200, events))
      .policy(observerFactory("early", 100, events))
      .build();

    await expect(client.call()).resolves.toBe("ok");

    expect(events).toEqual(["early:before", "late:before", "late:after", "early:after"]);
  });

  it("wires build-time event handlers into policy services", async () => {
    const handler = vi.fn();
    const event = createRequestStartedEvent();
    const factory = definePolicy({
      name: "emit",
      order: 100,
      create(services) {
        return {
          name: "emit",
          order: 100,
          execute<T>(ctx: Context, next: Next<T>): Promise<T> {
            services.emit(event);

            return next(ctx);
          },
        };
      },
    });
    const client = createBuilder(() => Promise.resolve("ok"))
      .on("RequestStarted", handler)
      .policy(factory)
      .build();

    await expect(client.call()).resolves.toBe("ok");

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("supports runtime client subscriptions in addition to build-time handlers", async () => {
    const buildHandler = vi.fn();
    const runtimeHandler = vi.fn();
    const event = createRequestStartedEvent();
    const factory = definePolicy({
      name: "emit",
      order: 100,
      create(services) {
        return {
          name: "emit",
          order: 100,
          execute<T>(ctx: Context, next: Next<T>): Promise<T> {
            services.emit(event);

            return next(ctx);
          },
        };
      },
    });
    const client = createBuilder(() => Promise.resolve("ok"))
      .on("RequestStarted", buildHandler)
      .policy(factory)
      .build();

    client.on("RequestStarted", runtimeHandler);

    await expect(client.call()).resolves.toBe("ok");

    expect(buildHandler).toHaveBeenCalledTimes(1);
    expect(runtimeHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid builder inputs", () => {
    expect(() => createBuilder(null as unknown as () => Promise<unknown>)).toThrow(
      ConfigurationError,
    );

    const builder = createBuilder(() => Promise.resolve("ok"));

    expect(() => builder.withClassifier({} as FailureClassifier)).toThrow(ConfigurationError);
    expect(() => builder.withStore({} as StateStore)).toThrow(ConfigurationError);
    expect(() => builder.withClock({} as Clock)).toThrow(ConfigurationError);
    expect(() => builder.on("RequestStarted", undefined as never)).toThrow(ConfigurationError);
    expect(() => builder.policy(null as unknown as PolicyFactory)).toThrow(ConfigurationError);
  });
});

function observerFactory(name: string, order: number, events: string[]): PolicyFactory {
  return definePolicy({
    name,
    order,
    create() {
      return {
        name,
        order,
        async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
          events.push(`${name}:before`);
          const result = await next(ctx);
          events.push(`${name}:after`);

          return result;
        },
      };
    },
  });
}

function passThroughPolicy(name: string, order: number) {
  return {
    name,
    order,
    execute<T>(ctx: Context, next: Next<T>): Promise<T> {
      return next(ctx);
    },
  };
}

function createClassifier(): FailureClassifier {
  return Object.freeze({
    isFailure(): boolean {
      return false;
    },
    isRetryable(): boolean {
      return false;
    },
  });
}

function createClock(): Clock {
  return Object.freeze({
    now(): number {
      return 1;
    },
    setTimeout(callback: () => void): ReturnType<typeof globalThis.setTimeout> {
      return globalThis.setTimeout(callback, 0);
    },
    clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
      globalThis.clearTimeout(handle);
    },
  });
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

function assertBuilderType(
  builder: Builder<readonly [string], string>,
): Builder<readonly [string], string> {
  return builder;
}

void assertBuilderType;
