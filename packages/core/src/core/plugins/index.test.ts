import { describe, expect, it, vi } from "vitest";

import { systemClock } from "../clock";
import { ConfigurationError } from "../errors";
import { noopMetrics } from "../metrics";
import { definePolicy, type PolicyFactory } from "../policy";
import { memoryStore } from "../state";
import { definePlugin, type PluginContext, type ResiliPlugin } from "./index";

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
