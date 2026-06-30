import { describe, expect, it, vi } from "vitest";

import { systemClock } from "../clock";
import { DefaultEventBus } from "../events";
import { ConfigurationError } from "../errors";
import { noopMetrics } from "../metrics";
import { definePolicy, type PolicyFactory } from "../policy";
import { memoryStore } from "../state";
import { definePlugin, installPlugins, type PluginContext, type ResiliPlugin } from "./index";

describe("definePlugin", () => {
  it("returns an immutable plugin with frozen dependencies", () => {
    const plugin = definePlugin({
      name: "observability",
      version: "1.0.0",
      apiVersion: "1.0.0",
      dependencies: ["base"],
      priority: 10,
      setup() {
        return { name: "observability" };
      },
    });

    expect(plugin.name).toBe("observability");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.apiVersion).toBe("1.0.0");
    expect(plugin.dependencies).toEqual(["base"]);
    expect(plugin.priority).toBe(10);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.dependencies)).toBe(true);
    expect(() => {
      (plugin as { name: string }).name = "changed";
    }).toThrow(TypeError);
  });

  it("does not mutate the input dependencies array", () => {
    const dependencies = ["base"];
    const plugin = definePlugin({
      name: "dependent",
      version: "1.0.0",
      apiVersion: "1.0.0",
      dependencies,
      setup() {
        return undefined;
      },
    });

    dependencies.push("later");

    expect(plugin.dependencies).toEqual(["base"]);
  });

  it("preserves setup this-binding while returning an immutable wrapper", () => {
    const original = {
      name: "stateful",
      version: "1.0.0",
      apiVersion: "1.0.0",
      instanceName: "stateful-instance",
      setup(): { readonly name: string } {
        return { name: this.instanceName };
      },
    };

    const plugin = definePlugin(original);

    expect(plugin.setup(createPluginContext(), undefined)).toEqual({
      name: "stateful-instance",
    });
  });

  it("does not execute setup during definition", () => {
    const setup = vi.fn<ResiliPlugin["setup"]>(() => ({ name: "lazy" }));

    const plugin = definePlugin({
      name: "lazy",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup,
    });

    expect(setup).not.toHaveBeenCalled();

    plugin.setup(createPluginContext(), undefined);

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("preserves generic option typing", () => {
    const setup = vi.fn((ctx: PluginContext, options: { readonly enabled: boolean }) => {
      ctx.logger.warn(String(options.enabled));

      return { name: "typed" };
    });
    const plugin = definePlugin<{ readonly enabled: boolean }>({
      name: "typed",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup,
    });

    plugin.setup(createPluginContext(), { enabled: true });

    expect(setup).toHaveBeenCalledWith(expect.any(Object), { enabled: true });
  });

  it("types plugin context methods with existing core interfaces", () => {
    const policy = definePolicy({
      name: "context-policy",
      order: 100,
      create() {
        return {
          name: "context-policy",
          order: 100,
          execute(_ctx, next) {
            return next(_ctx);
          },
        };
      },
    });
    const ctx = createPluginContext();

    ctx.registerPolicy(policy, { enabled: true });
    ctx.on("RequestStarted", (event) => {
      expect(event.deadline).toBeGreaterThanOrEqual(0);
    });
    ctx.useMetrics(noopMetrics);
    ctx.useStore(memoryStore());
    ctx.useClock(systemClock);

    expect(ctx.getPlugin("missing")).toBeUndefined();
  });

  it("rejects invalid plugin contracts", () => {
    expect(() => definePlugin(null as unknown as ResiliPlugin)).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "",
        version: "1.0.0",
        apiVersion: "1.0.0",
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "",
        apiVersion: "1.0.0",
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "1.0.0",
        apiVersion: "",
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "1.0.0",
        apiVersion: "1.0.0",
        setup: undefined as unknown as ResiliPlugin["setup"],
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects invalid dependencies and priority", () => {
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "1.0.0",
        apiVersion: "1.0.0",
        dependencies: "base" as unknown as readonly string[],
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "1.0.0",
        apiVersion: "1.0.0",
        dependencies: [""],
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      definePlugin({
        name: "invalid",
        version: "1.0.0",
        apiVersion: "1.0.0",
        priority: Number.NaN,
        setup() {
          return undefined;
        },
      }),
    ).toThrow(ConfigurationError);
  });
});

describe("installPlugins", () => {
  it("installs plugins by dependencies, priority, and stable input order", () => {
    const installed: string[] = [];
    const plugins = [
      createRegistration(
        definePlugin({
          name: "base",
          version: "1.0.0",
          apiVersion: "1.0.0",
          priority: 10,
          setup() {
            installed.push("base");

            return { name: "base" };
          },
        }),
        0,
      ),
      createRegistration(
        definePlugin({
          name: "dependent",
          version: "1.0.0",
          apiVersion: "1.0.0",
          dependencies: ["base"],
          priority: -100,
          setup() {
            installed.push("dependent");

            return { name: "dependent" };
          },
        }),
        1,
      ),
      createRegistration(
        definePlugin({
          name: "audit",
          version: "1.0.0",
          apiVersion: "1.0.0",
          priority: -1,
          setup() {
            installed.push("audit");

            return { name: "audit" };
          },
        }),
        2,
      ),
      createRegistration(
        definePlugin({
          name: "stable",
          version: "1.0.0",
          apiVersion: "1.0.0",
          priority: -1,
          setup() {
            installed.push("stable");

            return { name: "stable" };
          },
        }),
        3,
      ),
    ];

    const result = installPlugins(createInstallInput(plugins));

    expect(installed).toEqual(["audit", "stable", "base", "dependent"]);
    expect(result.instances.map((instance) => instance.name)).toEqual([
      "audit",
      "stable",
      "base",
      "dependent",
    ]);
    expect(Object.isFrozen(result.instances)).toBe(true);
  });

  it("rejects duplicate plugin names, missing dependencies, and cycles", () => {
    const base = definePlugin({
      name: "base",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup() {
        return undefined;
      },
    });

    expect(() =>
      installPlugins(
        createInstallInput([createRegistration(base, 0), createRegistration(base, 1)]),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      installPlugins(
        createInstallInput([
          createRegistration(
            definePlugin({
              name: "dependent",
              version: "1.0.0",
              apiVersion: "1.0.0",
              dependencies: ["missing"],
              setup() {
                return undefined;
              },
            }),
            0,
          ),
        ]),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      installPlugins(
        createInstallInput([
          createRegistration(
            definePlugin({
              name: "a",
              version: "1.0.0",
              apiVersion: "1.0.0",
              dependencies: ["b"],
              setup() {
                return undefined;
              },
            }),
            0,
          ),
          createRegistration(
            definePlugin({
              name: "b",
              version: "1.0.0",
              apiVersion: "1.0.0",
              dependencies: ["a"],
              setup() {
                return undefined;
              },
            }),
            1,
          ),
        ]),
      ),
    ).toThrow(ConfigurationError);
  });

  it("exposes setup context for policies, events, service overrides, and plugin lookup", () => {
    const events = new DefaultEventBus();
    const eventHandler = vi.fn();
    const policyFactory = definePolicy({
      name: "plugin-policy",
      order: 100,
      create() {
        return {
          name: "plugin-policy",
          order: 100,
          execute(_ctx, next) {
            return next(_ctx);
          },
        };
      },
    });
    const clock = systemClock;
    const store = memoryStore();
    const metrics = noopMetrics;
    const seenInstance = vi.fn();
    const plugins = [
      createRegistration(
        definePlugin({
          name: "base",
          version: "1.0.0",
          apiVersion: "1.0.0",
          setup() {
            return { name: "base-instance" };
          },
        }),
        0,
      ),
      createRegistration(
        definePlugin({
          name: "runtime",
          version: "1.0.0",
          apiVersion: "1.0.0",
          dependencies: ["base"],
          setup(ctx) {
            ctx.registerPolicy(policyFactory, { enabled: true });
            ctx.on("RequestStarted", eventHandler);
            ctx.useClock(clock);
            ctx.useStore(store);
            ctx.useMetrics(metrics);
            seenInstance(ctx.getPlugin("base-instance"));

            return { name: "runtime" };
          },
        }),
        1,
      ),
    ];

    const result = installPlugins({
      plugins,
      events,
      clock: createDifferentClock(),
      metrics: createDifferentMetrics(),
      store: memoryStore(),
    });

    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({ options: { enabled: true } });
    expect(result.clock).toBe(clock);
    expect(result.store).toBe(store);
    expect(result.metrics).toBe(metrics);
    expect(seenInstance).toHaveBeenCalledWith({ name: "base-instance" });
  });

  it("wraps setup failures in ConfigurationError", () => {
    const failure = new Error("boom");

    expect(() =>
      installPlugins(
        createInstallInput([
          createRegistration(
            definePlugin({
              name: "failing",
              version: "1.0.0",
              apiVersion: "1.0.0",
              setup() {
                throw failure;
              },
            }),
            0,
          ),
        ]),
      ),
    ).toThrow(ConfigurationError);
  });
});

function createPluginContext(): PluginContext {
  return {
    apiVersion: "1.0.0",
    registerPolicy(_factory: PolicyFactory, _options?: unknown): void {
      void _factory;
      void _options;
      // Test double.
    },
    on(): void {
      // Test double.
    },
    useMetrics(): void {
      // Test double.
    },
    useStore(): void {
      // Test double.
    },
    useClock(): void {
      // Test double.
    },
    getPlugin(): undefined {
      return undefined;
    },
    logger: {
      warn(): void {
        // Test double.
      },
    },
  };
}

function createRegistration(plugin: ResiliPlugin, index: number) {
  return Object.freeze({ plugin, index });
}

function createInstallInput(plugins: readonly ReturnType<typeof createRegistration>[]) {
  return {
    plugins,
    events: new DefaultEventBus(),
    clock: systemClock,
    metrics: noopMetrics,
    store: memoryStore(),
  };
}

function createDifferentClock() {
  return Object.freeze({
    now(): number {
      return 0;
    },
    setTimeout(callback: () => void): ReturnType<typeof globalThis.setTimeout> {
      return globalThis.setTimeout(callback, 0);
    },
    clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
      globalThis.clearTimeout(handle);
    },
  });
}

function createDifferentMetrics() {
  return Object.freeze({
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
}
