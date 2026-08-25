import type { Context, ContextInit } from "../context";
import {
  DefaultEventBus,
  type EventBus,
  type EventHandler,
  type ResiliEventType,
  type Unsubscribe,
} from "../events";
import type { Pipeline } from "../pipeline";

/**
 * Circuit-breaker state name used in client health and stats snapshots.
 *
 * @public
 */
export type CircuitState = "closed" | "open" | "half_open";

/**
 * Live client runtime stats.
 *
 * Totals are owned by the client. `totals.retries` counts extra attempts after
 * the first attempt (`RetryStarted` events), not total attempts.
 *
 * This snapshot does not include circuit, bulkhead, or rate-limiter maps.
 * Those policies keep process-local state on the policy instance; it is not
 * published through this client API.
 *
 * @public
 */
export interface ClientStats {
  readonly totals: {
    readonly calls: number;
    readonly successes: number;
    readonly failures: number;
    readonly retries: number;
  };
}

/**
 * Process-local snapshot derived from {@link Client.stats}.
 *
 * `status` is always `"healthy"` because Resili does not currently publish
 * policy snapshots (open circuits, queued bulkhead work) on the client.
 * Do not use this as a dependency readiness probe.
 *
 * @public
 */
export interface ClientHealth {
  readonly status: "healthy";
  readonly details: ClientStats;
}

/**
 * Immutable, reusable Resili client.
 *
 * @public
 */
export interface Client<Args extends readonly unknown[], R> {
  /**
   * Invokes the wrapped operation with its native signature through the pipeline.
   */
  call(...args: Args): Promise<R>;

  /**
   * Runs an arbitrary context-aware operation through the same pipeline.
   */
  execute<T = R>(operation: (ctx: Context) => Promise<T>, init?: ContextInit): Promise<T>;

  /**
   * Returns a cheap immutable snapshot of runtime state.
   */
  stats(): ClientStats;

  /**
   * Returns a health verdict derived from runtime state.
   */
  health(): ClientHealth;

  /**
   * Subscribes to a runtime event.
   */
  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe;

  /**
   * Releases client-owned listeners and resources.
   */
  destroy(): Promise<void>;
}

/**
 * Internal client construction input used by future builder/factory modules.
 *
 * @internal
 */
export interface CoreClientInit<Args extends readonly unknown[], R> {
  readonly operation: (...args: Args) => Promise<R>;
  readonly pipeline: Pipeline;
  readonly events?: EventBus;
  readonly createCallContextInit?: (args: Args) => ContextInit;
  readonly dispose?: () => void | Promise<void>;
}

interface ClientTotals {
  calls: number;
  successes: number;
  failures: number;
  retries: number;
}

/**
 * Creates an immutable core client.
 *
 * This is internal construction support for the future builder/factory layer.
 *
 * @internal
 */
export function createCoreClient<Args extends readonly unknown[], R>(
  init: CoreClientInit<Args, R>,
): Client<Args, R> {
  return new ImmutableClient(init);
}

class ImmutableClient<Args extends readonly unknown[], R> implements Client<Args, R> {
  readonly #operation: (...args: Args) => Promise<R>;
  readonly #pipeline: Pipeline;
  readonly #events: EventBus;
  readonly #createCallContextInit?: (args: Args) => ContextInit;
  readonly #dispose?: () => void | Promise<void>;
  readonly #totals: ClientTotals = {
    calls: 0,
    successes: 0,
    failures: 0,
    retries: 0,
  };
  readonly #unsubscribeRetryStats: Unsubscribe;
  #destroyed = false;

  constructor(init: CoreClientInit<Args, R>) {
    this.#operation = init.operation;
    this.#pipeline = init.pipeline;
    this.#events = init.events ?? new DefaultEventBus();
    if (init.createCallContextInit !== undefined) {
      this.#createCallContextInit = init.createCallContextInit;
    }
    if (init.dispose !== undefined) {
      this.#dispose = init.dispose;
    }
    this.#unsubscribeRetryStats = this.#events.on("RetryStarted", () => {
      this.#totals.retries += 1;
    });

    Object.freeze(this);
  }

  call(...args: Args): Promise<R> {
    return this.#run(() =>
      this.#pipeline.execute(() => this.#operation(...args), this.#createCallContextInit?.(args)),
    );
  }

  execute<T = R>(operation: (ctx: Context) => Promise<T>, init?: ContextInit): Promise<T> {
    return this.#run(() => this.#pipeline.execute(operation, init));
  }

  stats(): ClientStats {
    return createStatsSnapshot(this.#totals);
  }

  health(): ClientHealth {
    return Object.freeze({
      status: "healthy",
      details: this.stats(),
    });
  }

  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    return this.#events.on(type, handler);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#unsubscribeRetryStats();

    try {
      await this.#dispose?.();
    } finally {
      if (this.#events instanceof DefaultEventBus) {
        this.#events.clear();
      }
    }
  }

  async #run<T>(execute: () => Promise<T>): Promise<T> {
    this.#totals.calls += 1;

    try {
      const result = await execute();
      this.#totals.successes += 1;

      return result;
    } catch (error) {
      this.#totals.failures += 1;
      throw error;
    }
  }
}

function createStatsSnapshot(totals: ClientTotals): ClientStats {
  return Object.freeze({
    totals: Object.freeze({ ...totals }),
  });
}
