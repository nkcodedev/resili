import type { Outcome } from "../../core/classification";
import type { Context } from "../../core/context";
import { CircuitOpenError, ConfigurationError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Resolves a circuit-breaker partition key from the current context.
 *
 * @public
 */
export type KeyResolver = (ctx: Context) => string;

/**
 * Circuit-breaker rolling window configuration.
 *
 * @public
 */
export type CircuitBreakerWindow =
  | {
      readonly type: "count";
      readonly size: number;
    }
  | {
      readonly type: "time";
      readonly durationMs: number;
    };

/**
 * Circuit-breaker options.
 *
 * @public
 */
export interface CircuitBreakerOptions {
  readonly window?: CircuitBreakerWindow;
  readonly failureRateThreshold?: number;
  readonly slowCallDurationMs?: number;
  readonly slowCallRateThreshold?: number;
  readonly minimumThroughput?: number;
  readonly resetTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly successThreshold?: number;
  readonly key?: string | KeyResolver;
}

type CircuitBreakerStateName = "closed" | "open" | "half_open";

interface NormalizedCircuitBreakerOptions {
  readonly window: CircuitBreakerWindow;
  readonly failureRateThreshold: number;
  readonly slowCallDurationMs: number;
  readonly slowCallRateThreshold: number;
  readonly minimumThroughput: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxCalls: number;
  readonly successThreshold: number;
  readonly key?: string | KeyResolver;
}

interface CallSample {
  readonly timestamp: number;
  readonly failure: boolean;
  readonly slow: boolean;
}

interface CircuitState {
  state: CircuitBreakerStateName;
  openedAt: number;
  halfOpenActive: number;
  halfOpenSuccesses: number;
  readonly samples: CallSample[];
}

/**
 * Built-in circuit breaker policy factory.
 *
 * Pass {@link CircuitBreakerOptions} as factory options.
 *
 * @public
 */
export const circuitBreakerPolicy: PolicyFactory = definePolicy({
  name: "circuit-breaker",
  order: 300,
  create(services: PolicyServices, options?: unknown) {
    const breakerOptions = normalizeOptions(options);
    const breaker = new InMemoryCircuitBreaker(services, breakerOptions);

    return {
      name: "circuit-breaker",
      order: 300,
      async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        const key = resolveKey(breakerOptions.key, ctx);
        const permit = breaker.beforeCall(key, ctx);

        try {
          const startedAt = services.clock.now();
          const result = await next(ctx);
          const durationMs = Math.max(0, services.clock.now() - startedAt);

          breaker.afterSuccess(key, ctx, result, durationMs);

          return result;
        } catch (error) {
          const durationMs = Math.max(0, services.clock.now() - permit.startedAt);

          breaker.afterError(key, ctx, error, durationMs);
          throw error;
        }
      },
    };
  },
});

class InMemoryCircuitBreaker {
  readonly #services: PolicyServices;
  readonly #options: NormalizedCircuitBreakerOptions;
  readonly #states = new Map<string, CircuitState>();

  constructor(services: PolicyServices, options: NormalizedCircuitBreakerOptions) {
    this.#services = services;
    this.#options = options;
  }

  beforeCall(key: string, ctx: Context): { readonly startedAt: number } {
    const now = this.#services.clock.now();
    const state = this.#getState(key);

    if (state.state === "open") {
      const retryAfterMs = this.#retryAfterMs(state, now);

      if (retryAfterMs > 0) {
        throw new CircuitOpenError({
          key,
          retryAfterMs,
          context: ctx.snapshot(),
        });
      }

      state.state = "half_open";
      state.halfOpenActive = 0;
      state.halfOpenSuccesses = 0;
      this.#emitHalfOpened(ctx, key);
    }

    if (state.state === "half_open") {
      if (state.halfOpenActive >= this.#options.halfOpenMaxCalls) {
        throw new CircuitOpenError({
          key,
          retryAfterMs: this.#options.resetTimeoutMs,
          context: ctx.snapshot(),
        });
      }

      state.halfOpenActive += 1;
    }

    return Object.freeze({ startedAt: now });
  }

  afterSuccess(key: string, ctx: Context, value: unknown, durationMs: number): void {
    const state = this.#getState(key);
    const outcome: Outcome = Object.freeze({
      status: "success",
      value,
      durationMs,
    });
    const failure = this.#services.classifier.isFailure(outcome, ctx);
    const slow = this.#isSlow(durationMs);

    this.#recordResult(state, key, ctx, failure, slow);
  }

  afterError(key: string, ctx: Context, error: unknown, durationMs: number): void {
    const state = this.#getState(key);
    const outcome: Outcome = Object.freeze({
      status: "error",
      error,
      durationMs,
    });
    const failure = this.#services.classifier.isFailure(outcome, ctx);
    const slow = this.#isSlow(durationMs);

    this.#recordResult(state, key, ctx, failure, slow);
  }

  #recordResult(
    state: CircuitState,
    key: string,
    ctx: Context,
    failure: boolean,
    slow: boolean,
  ): void {
    if (state.state === "half_open") {
      state.halfOpenActive = Math.max(0, state.halfOpenActive - 1);

      if (failure || slow) {
        this.#open(state, ctx, key, 100);
        return;
      }

      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses >= this.#options.successThreshold) {
        this.#close(state, ctx, key);
      }

      return;
    }

    if (state.state !== "closed") {
      return;
    }

    state.samples.push({
      timestamp: this.#services.clock.now(),
      failure,
      slow,
    });
    this.#trimSamples(state);
    this.#evaluateClosed(state, ctx, key);
  }

  #evaluateClosed(state: CircuitState, ctx: Context, key: string): void {
    const total = state.samples.length;

    if (total < this.#options.minimumThroughput) {
      return;
    }

    const failures = state.samples.filter((sample) => sample.failure).length;
    const slowCalls = state.samples.filter((sample) => sample.slow).length;
    const failureRate = (failures / total) * 100;
    const slowCallRate = (slowCalls / total) * 100;

    if (
      failureRate >= this.#options.failureRateThreshold ||
      (this.#options.slowCallDurationMs > 0 && slowCallRate >= this.#options.slowCallRateThreshold)
    ) {
      this.#open(state, ctx, key, failureRate);
    }
  }

  #open(state: CircuitState, ctx: Context, key: string, failureRate: number): void {
    state.state = "open";
    state.openedAt = this.#services.clock.now();
    state.halfOpenActive = 0;
    state.halfOpenSuccesses = 0;

    this.#services.emit({
      type: "CircuitOpened",
      timestamp: state.openedAt,
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
      failureRate,
      resetAt: state.openedAt + this.#options.resetTimeoutMs,
    });
  }

  #close(state: CircuitState, ctx: Context, key: string): void {
    state.state = "closed";
    state.openedAt = 0;
    state.halfOpenActive = 0;
    state.halfOpenSuccesses = 0;
    state.samples.length = 0;

    this.#services.emit({
      type: "CircuitClosed",
      timestamp: this.#services.clock.now(),
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
    });
  }

  #emitHalfOpened(ctx: Context, key: string): void {
    this.#services.emit({
      type: "CircuitHalfOpened",
      timestamp: this.#services.clock.now(),
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
      probesAllowed: this.#options.halfOpenMaxCalls,
    });
  }

  #trimSamples(state: CircuitState): void {
    if (this.#options.window.type === "count") {
      while (state.samples.length > this.#options.window.size) {
        state.samples.shift();
      }

      return;
    }

    const windowStart = this.#services.clock.now() - this.#options.window.durationMs;

    while (state.samples.length > 0 && (state.samples[0]?.timestamp ?? 0) <= windowStart) {
      state.samples.shift();
    }
  }

  #retryAfterMs(state: CircuitState, now: number): number {
    return Math.max(0, state.openedAt + this.#options.resetTimeoutMs - now);
  }

  #isSlow(durationMs: number): boolean {
    return this.#options.slowCallDurationMs > 0 && durationMs >= this.#options.slowCallDurationMs;
  }

  #getState(key: string): CircuitState {
    let state = this.#states.get(key);

    if (state === undefined) {
      state = {
        state: "closed",
        openedAt: 0,
        halfOpenActive: 0,
        halfOpenSuccesses: 0,
        samples: [],
      };
      this.#states.set(key, state);
    }

    return state;
  }
}

function normalizeOptions(options: unknown): NormalizedCircuitBreakerOptions {
  if (options === undefined) {
    return DEFAULT_OPTIONS;
  }

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Circuit breaker options must be an object.", {
      field: "circuitBreaker",
    });
  }

  const candidate = options as Partial<CircuitBreakerOptions>;
  const window = normalizeWindow(candidate.window);
  const failureRateThreshold = candidate.failureRateThreshold ?? 50;
  const slowCallDurationMs = candidate.slowCallDurationMs ?? 0;
  const slowCallRateThreshold = candidate.slowCallRateThreshold ?? 100;
  const minimumThroughput = candidate.minimumThroughput ?? 10;
  const resetTimeoutMs = candidate.resetTimeoutMs ?? 30_000;
  const halfOpenMaxCalls = candidate.halfOpenMaxCalls ?? 1;
  const successThreshold = candidate.successThreshold ?? 1;

  validatePercentage(failureRateThreshold, "circuitBreaker.failureRateThreshold");
  validateNumberAtLeast(slowCallDurationMs, 0, "circuitBreaker.slowCallDurationMs");
  validatePercentage(slowCallRateThreshold, "circuitBreaker.slowCallRateThreshold");
  validateIntegerAtLeast(minimumThroughput, 1, "circuitBreaker.minimumThroughput");
  validateNumberGreaterThan(resetTimeoutMs, 0, "circuitBreaker.resetTimeoutMs");
  validateIntegerAtLeast(halfOpenMaxCalls, 1, "circuitBreaker.halfOpenMaxCalls");
  validateIntegerAtLeast(successThreshold, 1, "circuitBreaker.successThreshold");

  if (window.type === "count" && minimumThroughput > window.size) {
    throw new ConfigurationError(
      "circuitBreaker.minimumThroughput cannot exceed count window size.",
      {
        field: "circuitBreaker.minimumThroughput",
      },
    );
  }

  if (successThreshold > halfOpenMaxCalls) {
    throw new ConfigurationError(
      "circuitBreaker.successThreshold cannot exceed halfOpenMaxCalls.",
      {
        field: "circuitBreaker.successThreshold",
      },
    );
  }

  if (candidate.slowCallRateThreshold !== undefined && candidate.slowCallDurationMs === undefined) {
    throw new ConfigurationError(
      "circuitBreaker.slowCallRateThreshold requires slowCallDurationMs.",
      {
        field: "circuitBreaker.slowCallRateThreshold",
      },
    );
  }

  if (candidate.key !== undefined) {
    validateKey(candidate.key);
  }

  return Object.freeze({
    window,
    failureRateThreshold,
    slowCallDurationMs,
    slowCallRateThreshold,
    minimumThroughput,
    resetTimeoutMs,
    halfOpenMaxCalls,
    successThreshold,
    ...(candidate.key === undefined ? {} : { key: candidate.key }),
  });
}

const DEFAULT_OPTIONS: NormalizedCircuitBreakerOptions = Object.freeze({
  window: Object.freeze({ type: "count", size: 100 }),
  failureRateThreshold: 50,
  slowCallDurationMs: 0,
  slowCallRateThreshold: 100,
  minimumThroughput: 10,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
  successThreshold: 1,
});

function normalizeWindow(window: CircuitBreakerOptions["window"]): CircuitBreakerWindow {
  if (window === undefined) {
    return DEFAULT_OPTIONS.window;
  }

  if (window.type === "count") {
    validateIntegerAtLeast(window.size, 1, "circuitBreaker.window.size");

    return Object.freeze({ type: "count", size: window.size });
  }

  validateNumberGreaterThan(window.durationMs, 0, "circuitBreaker.window.durationMs");

  return Object.freeze({ type: "time", durationMs: window.durationMs });
}

function resolveKey(key: string | KeyResolver | undefined, ctx: Context): string {
  const resolved = key === undefined ? ctx.serviceName : typeof key === "function" ? key(ctx) : key;

  validateResolvedKey(resolved);

  return resolved;
}

function validatePercentage(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new ConfigurationError(`${field} must be greater than 0 and less than or equal to 100.`, {
      field,
    });
  }
}

function validateIntegerAtLeast(
  value: unknown,
  min: number,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ConfigurationError(
      `${field} must be an integer greater than or equal to ${String(min)}.`,
      {
        field,
      },
    );
  }
}

function validateNumberAtLeast(
  value: unknown,
  min: number,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new ConfigurationError(`${field} must be greater than or equal to ${String(min)}.`, {
      field,
    });
  }
}

function validateNumberGreaterThan(
  value: unknown,
  min: number,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= min) {
    throw new ConfigurationError(`${field} must be greater than ${String(min)}.`, { field });
  }
}

function validateKey(key: string | KeyResolver): void {
  if (typeof key === "function") {
    return;
  }

  validateResolvedKey(key);
}

function validateResolvedKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError("circuitBreaker.key must resolve to a non-empty string.", {
      field: "circuitBreaker.key",
    });
  }
}
