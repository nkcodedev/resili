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
 * Policy-specific maps are populated by concrete policy implementations as
 * they become available. The client owns aggregate call totals.
 *
 * @public
 */
export interface ClientStats {
  readonly circuit: Readonly<
    Record<
      string,
      { readonly state: CircuitState; readonly failureRate: number; readonly calls: number }
    >
  >;
  readonly bulkhead: Readonly<Record<string, { readonly active: number; readonly queued: number }>>;
  readonly rateLimiter: Readonly<Record<string, { readonly available: number }>>;
  readonly totals: {
    readonly calls: number;
    readonly successes: number;
    readonly failures: number;
    readonly retries: number;
  };
}

/**
 * Derived health verdict for readiness and liveness checks.
 *
 * @public
 */
export interface ClientHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly openCircuits: readonly string[];
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

const EMPTY_CIRCUIT_STATS = Object.freeze({}) as ClientStats["circuit"];
const EMPTY_BULKHEAD_STATS = Object.freeze({}) as ClientStats["bulkhead"];
const EMPTY_RATE_LIMITER_STATS = Object.freeze({}) as ClientStats["rateLimiter"];

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
    const details = this.stats();
    const openCircuits = Object.entries(details.circuit)
      .filter(([, circuit]) => circuit.state === "open")
      .map(([key]) => key);
    const hasHalfOpenCircuit = Object.values(details.circuit).some(
      (circuit) => circuit.state === "half_open",
    );
    const hasQueuedBulkhead = Object.values(details.bulkhead).some(
      (bulkhead) => bulkhead.queued > 0,
    );

    return Object.freeze({
      status:
        openCircuits.length > 0
          ? "unhealthy"
          : hasHalfOpenCircuit || hasQueuedBulkhead
            ? "degraded"
            : "healthy",
      openCircuits: Object.freeze(openCircuits),
      details,
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
    circuit: EMPTY_CIRCUIT_STATS,
    bulkhead: EMPTY_BULKHEAD_STATS,
    rateLimiter: EMPTY_RATE_LIMITER_STATS,
    totals: Object.freeze({ ...totals }),
  });
}
