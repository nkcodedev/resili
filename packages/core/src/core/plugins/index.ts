import type { Clock } from "../clock";
import type { EventHandler, ResiliEventType } from "../events";
import { ConfigurationError } from "../errors";
import type { MetricsRecorder } from "../metrics";
import type { PolicyFactory } from "../policy";
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
