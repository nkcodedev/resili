import { httpClassifier, type FailureClassifier } from "../classification";
import { systemClock, type Clock } from "../clock";
import { createCoreClient, type Client } from "../client";
import {
  DefaultEventBus,
  type EventHandler,
  type ResiliEvent,
  type ResiliEventType,
} from "../events";
import { ConfigurationError } from "../errors";
import { noopMetrics, type MetricsRecorder } from "../metrics";
import { compilePipeline } from "../pipeline";
import { definePolicy, type PolicyFactory, type PolicyServices } from "../policy";
import {
  definePlugin,
  installPlugins,
  type PluginInstance,
  type PluginRegistration,
  type ResiliPlugin,
} from "../plugins";
import { memoryStore, type StateStore } from "../state";
import { bulkheadPolicy, type BulkheadOptions } from "../../policies/bulkhead";
import { circuitBreakerPolicy, type CircuitBreakerOptions } from "../../policies/circuit-breaker";
import {
  DEDUPE_OPERATION_ARGS_METADATA_KEY,
  dedupePolicy,
  type DedupeOptions,
} from "../../policies/dedupe";
import { fallbackPolicy, type FallbackFn, type FallbackOptions } from "../../policies/fallback";
import { hedgePolicy, type HedgeOptions } from "../../policies/hedge";
import { rateLimiterPolicy, type RateLimiterOptions } from "../../policies/rate-limiter";
import { retryPolicy, type RetryOptions } from "../../policies/retry";
import { timeoutPolicy, type TimeoutOptions } from "../../policies/timeout";

/**
 * Any wrappable async operation; arg and return types are preserved end-to-end.
 *
 * @public
 */
export type Operation<Args extends readonly unknown[], R> = (...args: Args) => Promise<R>;

/**
 * Minimal immutable builder for client construction.
 *
 * This module intentionally supports only the contracts backed by implemented
 * core modules. Built-in policy shortcuts, plugins, factories, and declarative
 * config are deferred until their modules exist.
 *
 * @public
 */
export interface Builder<Args extends readonly unknown[], R> {
  /**
   * Adds the built-in retry policy.
   */
  retry(options?: RetryOptions): this;

  /**
   * Adds the built-in timeout policy.
   */
  timeout(options: number | TimeoutOptions): this;

  /**
   * Adds the built-in request deduplication policy.
   */
  dedupe(options: DedupeOptions<Args>): this;

  /**
   * Adds the built-in hedged request policy.
   */
  hedge(options: HedgeOptions<R>): this;

  /**
   * Adds the built-in circuit breaker policy.
   */
  circuitBreaker(options?: CircuitBreakerOptions): this;

  /**
   * Adds the built-in bulkhead policy.
   */
  bulkhead(options: number | BulkheadOptions): this;

  /**
   * Adds the built-in rate limiter policy.
   */
  rateLimiter(options: RateLimiterOptions): this;

  /**
   * Adds the built-in fallback policy.
   */
  fallback(options: FallbackOptions<R> | FallbackFn<R>): this;

  /**
   * Registers a plugin for setup during build.
   */
  use<O = void>(plugin: ResiliPlugin<O>, options?: O): this;

  /**
   * Registers a custom policy factory for the future client pipeline.
   */
  policy(factory: PolicyFactory, options?: unknown): this;

  /**
   * Replaces the default failure classifier.
   */
  withClassifier(classifier: FailureClassifier): this;

  /**
   * Replaces the default state store.
   */
  withStore(store: StateStore): this;

  /**
   * Replaces the default clock.
   */
  withClock(clock: Clock): this;

  /**
   * Subscribes a handler to the client event bus at build time.
   */
  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): this;

  /**
   * Builds an immutable client from this builder snapshot.
   */
  build(): Client<Args, R>;
}

interface PolicyRegistration {
  readonly factory: PolicyFactory;
  readonly options?: unknown;
}

interface EventRegistration<T extends ResiliEventType = ResiliEventType> {
  readonly type: T;
  readonly handler: EventHandler<T>;
}

interface BuilderState<Args extends readonly unknown[], R> {
  readonly operation: Operation<Args, R>;
  readonly policies: readonly PolicyRegistration[];
  readonly plugins: readonly PluginRegistration[];
  readonly events: readonly EventRegistration[];
  readonly classifier: FailureClassifier;
  readonly store: StateStore;
  readonly clock: Clock;
  readonly metrics: MetricsRecorder;
}

/**
 * Creates a minimal immutable builder.
 *
 * This is internal construction support for future public factory modules.
 *
 * @internal
 */
export function createBuilder<Args extends readonly unknown[], R>(
  operation: Operation<Args, R>,
): Builder<Args, R> {
  validateOperation(operation);

  return new ImmutableBuilder({
    operation,
    policies: Object.freeze([]),
    plugins: Object.freeze([]),
    events: Object.freeze([]),
    classifier: httpClassifier,
    store: memoryStore(),
    clock: systemClock,
    metrics: noopMetrics,
  });
}

class ImmutableBuilder<Args extends readonly unknown[], R> implements Builder<Args, R> {
  readonly #state: BuilderState<Args, R>;

  constructor(state: BuilderState<Args, R>) {
    this.#state = freezeState(state);

    Object.freeze(this);
  }

  retry(options?: RetryOptions): this {
    return this.policy(retryPolicy, options);
  }

  timeout(options: number | TimeoutOptions): this {
    return this.policy(timeoutPolicy, options);
  }

  dedupe(options: DedupeOptions<Args>): this {
    return this.policy(dedupePolicy, options);
  }

  hedge(options: HedgeOptions<R>): this {
    return this.policy(hedgePolicy, options);
  }

  circuitBreaker(options?: CircuitBreakerOptions): this {
    return this.policy(circuitBreakerPolicy, options);
  }

  bulkhead(options: number | BulkheadOptions): this {
    return this.policy(bulkheadPolicy, options);
  }

  rateLimiter(options: RateLimiterOptions): this {
    return this.policy(rateLimiterPolicy, options);
  }

  fallback(options: FallbackOptions<R> | FallbackFn<R>): this {
    const fallbackOptions = typeof options === "function" ? { handler: options } : options;

    return this.policy(fallbackPolicy, fallbackOptions);
  }

  use<O = void>(plugin: ResiliPlugin<O>, options?: O): this {
    const validatedPlugin = definePlugin(plugin);

    return this.#next({
      plugins: Object.freeze([
        ...this.#state.plugins,
        freezePluginRegistration(validatedPlugin, options, this.#state.plugins.length),
      ]),
    });
  }

  policy(factory: PolicyFactory, options?: unknown): this {
    const validatedFactory = definePolicy(factory);

    return this.#next({
      policies: Object.freeze([
        ...this.#state.policies,
        freezePolicyRegistration(validatedFactory, options),
      ]),
    });
  }

  withClassifier(classifier: FailureClassifier): this {
    validateClassifier(classifier);

    return this.#next({ classifier });
  }

  withStore(store: StateStore): this {
    validateStore(store);

    return this.#next({ store });
  }

  withClock(clock: Clock): this {
    validateClock(clock);

    return this.#next({ clock });
  }

  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): this {
    validateEventType(type);
    validateHandler(handler);

    return this.#next({
      events: Object.freeze([
        ...this.#state.events,
        Object.freeze({ type, handler }) as EventRegistration,
      ]),
    });
  }

  build(): Client<Args, R> {
    const events = new DefaultEventBus();

    for (const registration of this.#state.events) {
      events.on(registration.type, registration.handler);
    }

    const installedPlugins = installPlugins({
      plugins: this.#state.plugins,
      events,
      clock: this.#state.clock,
      metrics: this.#state.metrics,
      store: this.#state.store,
    });

    const services: PolicyServices = Object.freeze({
      clock: installedPlugins.clock,
      metrics: installedPlugins.metrics,
      emit(event: ResiliEvent): void {
        events.emit(event);
      },
      store: installedPlugins.store,
      classifier: this.#state.classifier,
    });
    const policyRegistrations = [...this.#state.policies, ...installedPlugins.policies];
    const policies = policyRegistrations.map(({ factory, options }) =>
      factory.create(services, options),
    );
    const pipeline = compilePipeline(policies);
    const hasDedupePolicy = policyRegistrations.some(
      (registration) => registration.factory.name === dedupePolicy.name,
    );

    return createCoreClient({
      operation: this.#state.operation,
      pipeline,
      events,
      ...(hasDedupePolicy
        ? {
            createCallContextInit(args: Args) {
              return {
                metadata: {
                  [DEDUPE_OPERATION_ARGS_METADATA_KEY]: args,
                },
              };
            },
          }
        : {}),
      dispose: createPluginDisposer(installedPlugins.instances),
    });
  }

  #next(state: Partial<BuilderState<Args, R>>): this {
    return new ImmutableBuilder({
      ...this.#state,
      ...state,
    }) as this;
  }
}

function freezeState<Args extends readonly unknown[], R>(
  state: BuilderState<Args, R>,
): BuilderState<Args, R> {
  return Object.freeze({
    operation: state.operation,
    policies: Object.freeze([...state.policies]),
    plugins: Object.freeze([...state.plugins]),
    events: Object.freeze([...state.events]),
    classifier: state.classifier,
    store: state.store,
    clock: state.clock,
    metrics: state.metrics,
  });
}

function freezePolicyRegistration(factory: PolicyFactory, options: unknown): PolicyRegistration {
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

function freezePluginRegistration<O>(
  plugin: ResiliPlugin<O>,
  options: O | undefined,
  index: number,
): PluginRegistration<O> {
  return Object.freeze(
    options === undefined
      ? {
          plugin,
          index,
        }
      : {
          plugin,
          options,
          index,
        },
  );
}

function createPluginDisposer(instances: readonly PluginInstance[]): () => Promise<void> {
  return async () => {
    for (let index = instances.length - 1; index >= 0; index -= 1) {
      await instances[index]?.dispose?.();
    }
  };
}

function validateOperation(operation: unknown): void {
  if (typeof operation !== "function") {
    throw new ConfigurationError("Builder operation must be a function.", {
      field: "operation",
    });
  }
}

function validateClassifier(classifier: unknown): asserts classifier is FailureClassifier {
  if (classifier === null || typeof classifier !== "object") {
    throw new ConfigurationError("classifier must be an object.", {
      field: "classifier",
    });
  }

  const candidate = classifier as Partial<FailureClassifier>;

  if (typeof candidate.isFailure !== "function") {
    throw new ConfigurationError("classifier.isFailure must be a function.", {
      field: "classifier.isFailure",
    });
  }

  if (typeof candidate.isRetryable !== "function") {
    throw new ConfigurationError("classifier.isRetryable must be a function.", {
      field: "classifier.isRetryable",
    });
  }

  if (candidate.retryAfter !== undefined && typeof candidate.retryAfter !== "function") {
    throw new ConfigurationError("classifier.retryAfter must be a function.", {
      field: "classifier.retryAfter",
    });
  }
}

function validateStore(store: unknown): asserts store is StateStore {
  if (store === null || typeof store !== "object") {
    throw new ConfigurationError("store must be an object.", { field: "store" });
  }

  const candidate = store as Partial<StateStore>;

  if (
    typeof candidate.get !== "function" ||
    typeof candidate.set !== "function" ||
    typeof candidate.incr !== "function" ||
    typeof candidate.withLock !== "function"
  ) {
    throw new ConfigurationError("store must implement StateStore.", { field: "store" });
  }
}

function validateClock(clock: unknown): asserts clock is Clock {
  if (clock === null || typeof clock !== "object") {
    throw new ConfigurationError("clock must be an object.", { field: "clock" });
  }

  const candidate = clock as Partial<Clock>;

  if (
    typeof candidate.now !== "function" ||
    typeof candidate.setTimeout !== "function" ||
    typeof candidate.clearTimeout !== "function"
  ) {
    throw new ConfigurationError("clock must implement Clock.", { field: "clock" });
  }
}

function validateEventType(type: unknown): asserts type is ResiliEventType {
  if (typeof type !== "string" || type.length === 0) {
    throw new ConfigurationError("event type must be a non-empty string.", {
      field: "event.type",
    });
  }
}

function validateHandler(handler: unknown): asserts handler is EventHandler<ResiliEventType> {
  if (typeof handler !== "function") {
    throw new ConfigurationError("event handler must be a function.", {
      field: "event.handler",
    });
  }
}
