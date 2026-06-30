import type { Clock } from "../clock";
import type { EventBus, EventHandler, ResiliEventType } from "../events";
import { ConfigurationError } from "../errors";
import type { MetricsRecorder } from "../metrics";
import { definePolicy, type PolicyFactory } from "../policy";
import type { StateStore } from "../state";

/**
 * Plugin contract used by future builder integration.
 *
 * Plugins describe metadata and a setup hook. The setup hook is intentionally
 * not executed by this module; lifecycle and dependency ordering belong to the
 * builder/plugin installer layer.
 *
 * @public
 */
export interface ResiliPlugin<O = void> {
  /**
   * Stable plugin name used for diagnostics and future dependency resolution.
   */
  readonly name: string;

  /**
   * Plugin package or implementation version.
   */
  readonly version: string;

  /**
   * Resili plugin API version targeted by this plugin.
   */
  readonly apiVersion: string;

  /**
   * Names of plugins that must be installed before this plugin.
   */
  readonly dependencies?: readonly string[];

  /**
   * Setup priority used by future plugin installation ordering.
   */
  readonly priority?: number;

  /**
   * Configures the plugin against the provided plugin context.
   */
  setup(ctx: PluginContext, options: O): PluginInstance | undefined;
}

/**
 * Setup-time context available to plugins.
 *
 * This is a contract only. Runtime registration, dependency ordering, service
 * override application, and lifecycle handling are implemented by future
 * builder integration.
 *
 * @public
 */
export interface PluginContext {
  /**
   * Resili plugin API version exposed by the host.
   */
  readonly apiVersion: string;

  /**
   * Registers a policy factory for future pipeline construction.
   */
  registerPolicy(factory: PolicyFactory, options?: unknown): void;

  /**
   * Registers an event handler for future client event wiring.
   */
  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): void;

  /**
   * Replaces the metrics recorder used by future policy services.
   */
  useMetrics(recorder: MetricsRecorder): void;

  /**
   * Replaces the state store used by future policy services.
   */
  useStore(store: StateStore): void;

  /**
   * Replaces the clock used by future policy services.
   */
  useClock(clock: Clock): void;

  /**
   * Returns an installed plugin instance by name when available.
   */
  getPlugin(name: string): PluginInstance | undefined;

  /**
   * Setup-time logger for non-fatal plugin diagnostics.
   */
  readonly logger: {
    warn(message: string): void;
  };
}

/**
 * Runtime instance optionally returned from plugin setup.
 *
 * @public
 */
export interface PluginInstance {
  /**
   * Stable plugin instance name.
   */
  readonly name: string;

  /**
   * Releases plugin resources during future client destruction.
   */
  dispose?(): void | Promise<void>;
}

/**
 * Defines an immutable Resili plugin contract.
 *
 * This helper validates plugin metadata only. It does not execute setup,
 * resolve dependencies, validate API compatibility, or register lifecycle
 * hooks.
 *
 * @public
 */
export function definePlugin<O = void>(plugin: ResiliPlugin<O>): ResiliPlugin<O> {
  validatePlugin(plugin);

  const dependencies =
    plugin.dependencies === undefined ? undefined : Object.freeze([...plugin.dependencies]);

  return Object.freeze({
    name: plugin.name,
    version: plugin.version,
    apiVersion: plugin.apiVersion,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(plugin.priority === undefined ? {} : { priority: plugin.priority }),
    setup: plugin.setup.bind(plugin),
  });
}

/**
 * Internal immutable plugin registration captured by the builder.
 *
 * @internal
 */
export interface PluginRegistration<O = unknown> {
  readonly plugin: ResiliPlugin<O>;
  readonly options?: O;
  readonly index: number;
}

/**
 * Internal plugin installer input.
 *
 * @internal
 */
export interface PluginInstallInput {
  readonly plugins: readonly PluginRegistration[];
  readonly events: EventBus;
  readonly clock: Clock;
  readonly metrics: MetricsRecorder;
  readonly store: StateStore;
}

/**
 * Internal policy registration produced by plugin setup hooks.
 *
 * @internal
 */
export interface PluginPolicyRegistration {
  readonly factory: PolicyFactory;
  readonly options?: unknown;
}

/**
 * Internal plugin installation result consumed by the builder.
 *
 * @internal
 */
export interface PluginInstallResult {
  readonly policies: readonly PluginPolicyRegistration[];
  readonly instances: readonly PluginInstance[];
  readonly clock: Clock;
  readonly metrics: MetricsRecorder;
  readonly store: StateStore;
}

/**
 * Installs plugins in dependency and priority order.
 *
 * This intentionally does not perform API-version compatibility checks.
 *
 * @internal
 */
export function installPlugins(input: PluginInstallInput): PluginInstallResult {
  const orderedPlugins = orderPlugins(input.plugins);
  const policies: PluginPolicyRegistration[] = [];
  const instances: PluginInstance[] = [];
  const instanceByName = new Map<string, PluginInstance>();
  let clock = input.clock;
  let metrics = input.metrics;
  let store = input.store;

  for (const registration of orderedPlugins) {
    const ctx: PluginContext = Object.freeze({
      apiVersion: registration.plugin.apiVersion,
      registerPolicy(factory: PolicyFactory, options?: unknown): void {
        policies.push(freezePluginPolicyRegistration(definePolicy(factory), options));
      },
      on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): void {
        input.events.on(type, handler);
      },
      useMetrics(recorder: MetricsRecorder): void {
        metrics = recorder;
      },
      useStore(nextStore: StateStore): void {
        store = nextStore;
      },
      useClock(nextClock: Clock): void {
        clock = nextClock;
      },
      getPlugin(name: string): PluginInstance | undefined {
        return instanceByName.get(name);
      },
      logger: Object.freeze({
        warn(): void {
          // Intentionally no-op until a logger service exists.
        },
      }),
    });

    const instance = setupPlugin(registration, ctx);

    if (instance !== undefined) {
      validatePluginInstance(instance, registration.plugin.name);
      if (instanceByName.has(instance.name)) {
        throw new ConfigurationError(`Duplicate plugin instance "${instance.name}".`, {
          field: "plugin.name",
        });
      }
      const frozenInstance = freezePluginInstance(instance);
      instances.push(frozenInstance);
      instanceByName.set(frozenInstance.name, frozenInstance);
    }
  }

  return Object.freeze({
    policies: Object.freeze([...policies]),
    instances: Object.freeze([...instances]),
    clock,
    metrics,
    store,
  });
}

function validatePlugin(plugin: unknown): asserts plugin is ResiliPlugin<unknown> {
  if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin)) {
    throw new ConfigurationError("Plugin must be an object.", { field: "plugin" });
  }

  const candidate = plugin as Partial<ResiliPlugin<unknown>>;

  validateName(candidate.name, "plugin.name");
  validateName(candidate.version, "plugin.version");
  validateName(candidate.apiVersion, "plugin.apiVersion");

  if (candidate.dependencies !== undefined) {
    validateDependencies(candidate.dependencies);
  }

  if (candidate.priority !== undefined && !Number.isFinite(candidate.priority)) {
    throw new ConfigurationError("plugin.priority must be a finite number.", {
      field: "plugin.priority",
    });
  }

  if (typeof candidate.setup !== "function") {
    throw new ConfigurationError("plugin.setup must be a function.", {
      field: "plugin.setup",
    });
  }
}

function orderPlugins(plugins: readonly PluginRegistration[]): readonly PluginRegistration[] {
  validateUniquePluginNames(plugins);
  validatePluginDependencies(plugins);

  const remaining = new Set(plugins);
  const installed = new Set<string>();
  const ordered: PluginRegistration[] = [];

  while (remaining.size > 0) {
    const candidates = [...remaining]
      .filter((registration) =>
        (registration.plugin.dependencies ?? []).every((dependency) => installed.has(dependency)),
      )
      .sort(comparePluginRegistration);

    if (candidates.length === 0) {
      throw new ConfigurationError("Plugin dependencies contain a cycle.", {
        field: "plugin.dependencies",
      });
    }

    for (const registration of candidates) {
      remaining.delete(registration);
      installed.add(registration.plugin.name);
      ordered.push(registration);
    }
  }

  return Object.freeze(ordered);
}

function comparePluginRegistration(left: PluginRegistration, right: PluginRegistration): number {
  const priorityDifference = (left.plugin.priority ?? 0) - (right.plugin.priority ?? 0);

  return priorityDifference === 0 ? left.index - right.index : priorityDifference;
}

function validateUniquePluginNames(plugins: readonly PluginRegistration[]): void {
  const names = new Set<string>();

  for (const { plugin } of plugins) {
    if (names.has(plugin.name)) {
      throw new ConfigurationError(`Duplicate plugin "${plugin.name}".`, {
        field: "plugin.name",
      });
    }
    names.add(plugin.name);
  }
}

function validatePluginDependencies(plugins: readonly PluginRegistration[]): void {
  const names = new Set(plugins.map(({ plugin }) => plugin.name));

  for (const { plugin } of plugins) {
    for (const dependency of plugin.dependencies ?? []) {
      if (!names.has(dependency)) {
        throw new ConfigurationError(
          `Plugin "${plugin.name}" depends on missing plugin "${dependency}".`,
          {
            field: "plugin.dependencies",
          },
        );
      }
    }
  }
}

function setupPlugin(
  registration: PluginRegistration,
  ctx: PluginContext,
): PluginInstance | undefined {
  try {
    return registration.plugin.setup(ctx, registration.options);
  } catch (error) {
    throw new ConfigurationError(`Plugin "${registration.plugin.name}" setup failed.`, {
      cause: error,
      field: "plugin.setup",
    });
  }
}

function freezePluginPolicyRegistration(
  factory: PolicyFactory,
  options: unknown,
): PluginPolicyRegistration {
  return Object.freeze(
    options === undefined
      ? {
          factory,
        }
      : {
          factory,
          options,
        },
  );
}

function validatePluginInstance(
  instance: unknown,
  pluginName: string,
): asserts instance is PluginInstance {
  if (instance === null || typeof instance !== "object" || Array.isArray(instance)) {
    throw new ConfigurationError(`Plugin "${pluginName}" setup must return a plugin instance.`, {
      field: "plugin.setup",
    });
  }

  const candidate = instance as Partial<PluginInstance>;

  validateName(candidate.name, "plugin.instance.name");

  if (candidate.dispose !== undefined && typeof candidate.dispose !== "function") {
    throw new ConfigurationError("plugin.instance.dispose must be a function.", {
      field: "plugin.instance.dispose",
    });
  }
}

function freezePluginInstance(instance: PluginInstance): PluginInstance {
  return Object.freeze(
    instance.dispose === undefined
      ? {
          name: instance.name,
        }
      : {
          name: instance.name,
          dispose: instance.dispose.bind(instance),
        },
  );
}

function validateName(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty string.`, { field });
  }
}

function validateDependencies(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError("plugin.dependencies must be an array.", {
      field: "plugin.dependencies",
    });
  }

  for (const dependency of value) {
    validateName(dependency, "plugin.dependencies");
  }
}
