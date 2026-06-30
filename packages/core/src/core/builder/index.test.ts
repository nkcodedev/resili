import { describe, expect, it, vi } from "vitest";

import { httpClassifier, type FailureClassifier } from "../classification";
import { systemClock, type Clock } from "../clock";
import { createContext, type Context } from "../context";
import type { ResiliEvent } from "../events";
import { ConfigurationError } from "../errors";
import { noopMetrics } from "../metrics";
import { definePolicy, type Next, type PolicyFactory, type PolicyServices } from "../policy";
import { definePlugin } from "../plugins";
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

  it("adds built-in policy methods as immutable chainable snapshots", () => {
    const builder = createBuilder(() => Promise.resolve("ok"));
    const snapshots = [
      builder.timeout(10),
      builder.bulkhead(1),
      builder.rateLimiter({ limit: 1, intervalMs: 100 }),
      builder.circuitBreaker(),
      builder.retry({ maxAttempts: 1, jitter: "none" }),
      builder.fallback(() => "fallback"),
    ];

    for (const snapshot of snapshots) {
      expect(snapshot).not.toBe(builder);
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
  });

  it("normalizes fallback function shorthand", async () => {
    const client = createBuilder(() => Promise.reject(new Error("failed")))
      .fallback(() => "fallback")
      .build();

    await expect(client.call()).resolves.toBe("fallback");
  });

  it("builds built-in policies from their options", async () => {
    const client = createBuilder(() => Promise.resolve("ok"))
      .timeout({ perAttemptMs: 100 })
      .bulkhead({ maxConcurrent: 1 })
      .rateLimiter({ limit: 1, intervalMs: 100 })
      .circuitBreaker({ minimumThroughput: 1 })
      .retry({ maxAttempts: 1, jitter: "none" })
      .fallback({
        handler() {
          return "fallback";
        },
      })
      .build();

    await expect(client.call()).resolves.toBe("ok");
  });

  it("registers plugins immutably and runs setup during build", async () => {
    const events: string[] = [];
    const setup = vi.fn();
    const plugin = definePlugin<{ readonly enabled: boolean }>({
      name: "observer-plugin",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup(ctx, options) {
        setup(options);
        ctx.registerPolicy(observerFactory("plugin-policy", 100, events));

        return { name: "observer-plugin" };
      },
    });
    const builder = createBuilder(() => Promise.resolve("ok"));
    const nextBuilder = builder.use(plugin, { enabled: true });

    expect(nextBuilder).not.toBe(builder);
    expect(Object.isFrozen(nextBuilder)).toBe(true);

    await builder.build().call();
    expect(events).toEqual([]);

    await nextBuilder.build().call();

    expect(setup).toHaveBeenCalledWith({ enabled: true });
    expect(events).toEqual(["plugin-policy:before", "plugin-policy:after"]);
  });

  it("orders plugin setup by dependency and priority before creating policies", async () => {
    const installed: string[] = [];
    const events: string[] = [];
    const lowPriority = definePlugin({
      name: "low",
      version: "1.0.0",
      apiVersion: "1.0.0",
      priority: 10,
      setup(ctx) {
        installed.push("low");
        ctx.registerPolicy(observerFactory("low", 200, events));

        return { name: "low" };
      },
    });
    const highPriority = definePlugin({
      name: "high",
      version: "1.0.0",
      apiVersion: "1.0.0",
      priority: -1,
      setup(ctx) {
        installed.push("high");
        ctx.registerPolicy(observerFactory("high", 100, events));

        return { name: "high" };
      },
    });
    const dependent = definePlugin({
      name: "dependent",
      version: "1.0.0",
      apiVersion: "1.0.0",
      dependencies: ["low"],
      priority: -100,
      setup() {
        installed.push("dependent");

        return { name: "dependent" };
      },
    });

    await createBuilder(() => Promise.resolve("ok"))
      .use(lowPriority)
      .use(dependent)
      .use(highPriority)
      .build()
      .call();

    expect(installed).toEqual(["high", "low", "dependent"]);
    expect(events).toEqual(["high:before", "low:before", "low:after", "high:after"]);
  });

  it("applies plugin event handlers and service overrides", async () => {
    const handler = vi.fn();
    const event = createRequestStartedEvent();
    const clock = createClock();
    const store = memoryStore();
    let capturedServices: PolicyServices | undefined;
    const metrics = Object.freeze({
      counter(name: string, help?: string) {
        return noopMetrics.counter(name, help);
      },
      gauge(name: string, help?: string) {
        return noopMetrics.gauge(name, help);
      },
      histogram(name: string, help?: string, buckets?: readonly number[]) {
        return noopMetrics.histogram(name, help, buckets);
      },
    });
    const plugin = definePlugin({
      name: "services",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup(ctx) {
        ctx.on("RequestStarted", handler);
        ctx.useClock(clock);
        ctx.useStore(store);
        ctx.useMetrics(metrics);
        ctx.registerPolicy(
          definePolicy({
            name: "capture",
            order: 100,
            create(services) {
              capturedServices = services;

              return {
                name: "capture",
                order: 100,
                execute<T>(ctx: Context, next: Next<T>): Promise<T> {
                  services.emit(event);

                  return next(ctx);
                },
              };
            },
          }),
        );

        return { name: "services" };
      },
    });

    await createBuilder(() => Promise.resolve("ok"))
      .use(plugin)
      .build()
      .call();

    expect(handler).toHaveBeenCalledWith(event);
    expect(capturedServices).toMatchObject({ clock, store, metrics });
  });

  it("disposes plugin instances in reverse install order on client destroy", async () => {
    const calls: string[] = [];
    const first = definePlugin({
      name: "first",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup() {
        return {
          name: "first",
          dispose() {
            calls.push("first");
          },
        };
      },
    });
    const second = definePlugin({
      name: "second",
      version: "1.0.0",
      apiVersion: "1.0.0",
      dependencies: ["first"],
      setup() {
        return {
          name: "second",
          dispose() {
            calls.push("second");
          },
        };
      },
    });
    const client = createBuilder(() => Promise.resolve("ok"))
      .use(first)
      .use(second)
      .build();

    await client.destroy();
    await client.destroy();

    expect(calls).toEqual(["second", "first"]);
  });

  it("rejects invalid plugin graphs during build", () => {
    const plugin = definePlugin({
      name: "duplicate",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup() {
        return undefined;
      },
    });
    const dependent = definePlugin({
      name: "dependent",
      version: "1.0.0",
      apiVersion: "1.0.0",
      dependencies: ["missing"],
      setup() {
        return undefined;
      },
    });

    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .use(plugin)
        .use(plugin)
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .use(dependent)
        .build(),
    ).toThrow(ConfigurationError);
  });

  it("preserves canonical built-in policy ordering regardless of chaining order", async () => {
    const clock = createManualClock();
    let calls = 0;
    const fallback = vi.fn(() => "fallback");
    const client = createBuilder(() => {
      calls += 1;

      return calls === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve("ok");
    })
      .withClock(clock)
      .retry({
        maxAttempts: 2,
        backoff: "fixed",
        baseDelayMs: 10,
        maxDelayMs: 10,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      })
      .fallback(fallback)
      .build();
    const result = client.call();

    await advanceManualClock(clock, 10);

    await expect(result).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("validates built-in policy options during build", () => {
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .timeout(0)
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .bulkhead(0)
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .rateLimiter({ limit: 0, intervalMs: 100 })
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .circuitBreaker({ failureRateThreshold: 0 })
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .retry({ jitter: "full" })
        .build(),
    ).toThrow(ConfigurationError);
    expect(() =>
      createBuilder(() => Promise.resolve("ok"))
        .fallback({ handler: undefined as never })
        .build(),
    ).toThrow(ConfigurationError);
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

interface ManualClock extends Clock {
  tick(ms: number): void;
}

function createManualClock(): ManualClock {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  return {
    now(): number {
      return now;
    },
    setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
      const handle = nextHandle++;

      timers.set(handle, {
        at: now + ms,
        callback,
      });

      return handle;
    },
    clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
      timers.delete(handle as number);
    },
    tick(ms: number): void {
      now += ms;

      for (const [handle, timer] of [...timers].sort(
        ([leftHandle], [rightHandle]) => leftHandle - rightHandle,
      )) {
        if (timer.at <= now && timers.delete(handle)) {
          timer.callback();
        }
      }
    },
  };
}

async function advanceManualClock(clock: ManualClock, ms: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  clock.tick(ms);
  await Promise.resolve();
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
