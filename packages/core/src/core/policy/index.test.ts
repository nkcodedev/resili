import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../classification";
import { systemClock } from "../clock";
import { createContext, type Context } from "../context";
import type { ResiliEvent } from "../events";
import { ConfigurationError } from "../errors";
import { noopMetrics } from "../metrics";
import { memoryStore } from "../state";
import {
  definePolicy,
  type Next,
  type Policy,
  type PolicyFactory,
  type PolicyOrder,
  type PolicyServices,
} from "./index";

describe("definePolicy", () => {
  it("returns an immutable factory with frozen relative order", () => {
    const factory = definePolicy({
      name: "observer",
      order: { before: "hedge" },
      create() {
        return passThroughPolicy("observer", { before: "hedge" });
      },
    });

    expect(factory.name).toBe("observer");
    expect(factory.order).toEqual({ before: "hedge" });
    expect(Object.isFrozen(factory)).toBe(true);
    expect(Object.isFrozen(factory.order)).toBe(true);
    expect(() => {
      (factory as { name: string }).name = "changed";
    }).toThrow(TypeError);
  });

  it("supports absolute numeric order", async () => {
    const factory = definePolicy({
      name: "absolute",
      order: 250,
      create() {
        return passThroughPolicy("absolute", 250);
      },
    });

    const policy = factory.create(createServices());
    const ctx = createTestContext();

    await expect(policy.execute(ctx, () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(policy.order).toBe(250);
  });

  it("freezes policies created by the factory", () => {
    const factory = definePolicy({
      name: "immutable-policy",
      order: { after: "timeout" },
      create() {
        return passThroughPolicy("immutable-policy", { after: "timeout" });
      },
    });

    const policy = factory.create(createServices());

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.order)).toBe(true);
    expect(() => {
      (policy as { name: string }).name = "changed";
    }).toThrow(TypeError);
  });

  it("forwards services and options to the original factory", () => {
    const services = createServices();
    const options = { enabled: true };
    const create = vi.fn<PolicyFactory["create"]>(() => passThroughPolicy("forward", 100));
    const factory = definePolicy({
      name: "forward",
      order: 100,
      create,
    });

    const policy = factory.create(services, options);

    expect(create).toHaveBeenCalledWith(services, options);
    expect(policy.name).toBe("forward");
  });

  it("preserves execute this-binding while returning an immutable policy wrapper", async () => {
    const factory = definePolicy({
      name: "stateful",
      order: 100,
      create() {
        return {
          name: "stateful",
          order: 100,
          prefix: "wrapped",
          async execute<T>(ctx: Context, next: Next<T>): Promise<T | string> {
            await next(ctx);

            return this.prefix;
          },
        } as Policy & { readonly prefix: string };
      },
    });

    const policy = factory.create(createServices());

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("ignored")),
    ).resolves.toBe("wrapped");
  });

  it("allows policies to short-circuit without calling next", async () => {
    const factory = definePolicy({
      name: "short-circuit",
      order: { before: "fallback" },
      create() {
        return {
          name: "short-circuit",
          order: { before: "fallback" },
          execute(): Promise<string> {
            return Promise.resolve("cached");
          },
        };
      },
    });
    const next = vi.fn<Next<string>>(() => Promise.resolve("downstream"));

    await expect(factory.create(createServices()).execute(createTestContext(), next)).resolves.toBe(
      "cached",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("supports side-effect-free observation around next", async () => {
    const events: string[] = [];
    const factory = definePolicy({
      name: "observer",
      order: { after: "retry" },
      create() {
        return {
          name: "observer",
          order: { after: "retry" },
          async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
            events.push(`before:${ctx.operationName}`);
            const result = await next(ctx);
            events.push("after");

            return result;
          },
        };
      },
    });

    await expect(
      factory.create(createServices()).execute(createTestContext(), () => Promise.resolve(42)),
    ).resolves.toBe(42);
    expect(events).toEqual(["before:operation", "after"]);
  });

  it("rejects invalid factories", () => {
    expect(() => definePolicy(null as unknown as PolicyFactory)).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "",
        order: 100,
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: Number.NaN,
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: 100,
        create: undefined as unknown as PolicyFactory["create"],
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects invalid relative order anchors", () => {
    expect(() =>
      definePolicy({
        name: "invalid",
        order: {} as PolicyOrder,
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: { before: "retry", after: "timeout" },
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: { before: "unknown" } as unknown as PolicyOrder,
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: [] as unknown as PolicyOrder,
        create() {
          return passThroughPolicy("invalid", 100);
        },
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects invalid policies returned by factories", () => {
    const services = createServices();

    expect(() =>
      definePolicy({
        name: "invalid",
        order: 100,
        create() {
          return null as unknown as Policy;
        },
      }).create(services),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: 100,
        create() {
          return { name: "", order: 100, execute: () => Promise.resolve(undefined) };
        },
      }).create(services),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: 100,
        create() {
          return {
            name: "invalid",
            order: {},
            execute: () => Promise.resolve(undefined),
          } as unknown as Policy;
        },
      }).create(services),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePolicy({
        name: "invalid",
        order: 100,
        create() {
          return {
            name: "invalid",
            order: 100,
            execute: undefined as unknown as Policy["execute"],
          };
        },
      }).create(services),
    ).toThrow(ConfigurationError);
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

function createServices(): PolicyServices {
  return Object.freeze({
    clock: systemClock,
    metrics: noopMetrics,
    emit(event: ResiliEvent): void {
      void event;
      // Tests only verify service wiring; event behavior belongs to core/events.
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
    startedAt: 1,
  });
}
