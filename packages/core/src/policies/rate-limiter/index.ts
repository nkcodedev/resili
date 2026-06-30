import type { Context } from "../../core/context";
import { ConfigurationError, RateLimitExceededError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Resolves a rate-limiter partition key from the current context.
 *
 * @public
 */
export type KeyResolver = (ctx: Context) => string;

/**
 * Rate limiter strategy.
 *
 * @public
 */
export type RateLimiterStrategy = "token-bucket" | "sliding-window";

/**
 * Behavior when the rate limit is reached.
 *
 * @public
 */
export type RateLimiterLimitBehavior = "reject" | "wait";

/**
 * Rate limiter admission-control options.
 *
 * @public
 */
export interface RateLimiterOptions {
  /**
   * Rate limiting algorithm.
   */
  readonly strategy?: RateLimiterStrategy;

  /**
   * Permits per interval.
   */
  readonly limit: number;

  /**
   * Interval duration in milliseconds.
   */
  readonly intervalMs: number;

  /**
   * Maximum token bucket capacity. Token bucket only.
   */
  readonly burst?: number;

  /**
   * Limit handling mode.
   */
  readonly onLimit?: RateLimiterLimitBehavior;

  /**
   * Maximum wait duration for wait mode.
   */
  readonly maxWaitMs?: number;

  /**
   * Static key or resolver. Defaults to `ctx.serviceName`.
   */
  readonly key?: string | KeyResolver;
}

interface NormalizedRateLimiterOptions {
  readonly strategy: RateLimiterStrategy;
  readonly limit: number;
  readonly intervalMs: number;
  readonly burst: number;
  readonly onLimit: "reject";
  readonly key?: string | KeyResolver;
}

interface TokenBucketState {
  tokens: number;
  updatedAt: number;
}

interface SlidingWindowState {
  readonly timestamps: number[];
}

/**
 * Built-in rate limiter policy factory.
 *
 * Pass {@link RateLimiterOptions} as factory options.
 *
 * @public
 */
export const rateLimiterPolicy: PolicyFactory = definePolicy({
  name: "rate-limiter",
  order: 500,
  create(services: PolicyServices, options?: unknown) {
    const limiterOptions = normalizeOptions(options);
    const limiter = new InMemoryRateLimiter(services, limiterOptions);

    return {
      name: "rate-limiter",
      order: 500,
      async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        limiter.acquire(ctx);

        return await next(ctx);
      },
    };
  },
});

class InMemoryRateLimiter {
  readonly #services: PolicyServices;
  readonly #options: NormalizedRateLimiterOptions;
  readonly #tokenBuckets = new Map<string, TokenBucketState>();
  readonly #slidingWindows = new Map<string, SlidingWindowState>();

  constructor(services: PolicyServices, options: NormalizedRateLimiterOptions) {
    this.#services = services;
    this.#options = options;
  }

  acquire(ctx: Context): void {
    const key = resolveKey(this.#options.key, ctx);
    const now = this.#services.clock.now();
    const result =
      this.#options.strategy === "token-bucket"
        ? this.#acquireTokenBucket(key, now)
        : this.#acquireSlidingWindow(key, now);

    if (result.allowed) {
      return;
    }

    const error = new RateLimitExceededError({
      retryAfterMs: result.retryAfterMs,
      context: ctx.snapshot(),
    });

    this.#services.emit({
      type: "RateLimited",
      timestamp: now,
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
      strategy: this.#options.strategy,
      retryAfterMs: result.retryAfterMs,
      waited: false,
    });

    throw error;
  }

  #acquireTokenBucket(
    key: string,
    now: number,
  ): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
    const state = this.#getTokenBucket(key, now);
    const elapsedMs = Math.max(0, now - state.updatedAt);
    const refill = (elapsedMs / this.#options.intervalMs) * this.#options.limit;

    state.tokens = Math.min(this.#options.burst, state.tokens + refill);
    state.updatedAt = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;

      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterMs: Math.ceil(
        ((1 - state.tokens) / this.#options.limit) * this.#options.intervalMs,
      ),
    };
  }

  #acquireSlidingWindow(
    key: string,
    now: number,
  ): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
    const state = this.#getSlidingWindow(key);
    const windowStart = now - this.#options.intervalMs;

    while (state.timestamps.length > 0 && (state.timestamps[0] ?? 0) <= windowStart) {
      state.timestamps.shift();
    }

    if (state.timestamps.length < this.#options.limit) {
      state.timestamps.push(now);

      return { allowed: true };
    }

    const oldest = state.timestamps[0] ?? now;

    return {
      allowed: false,
      retryAfterMs: Math.max(1, Math.ceil(oldest + this.#options.intervalMs - now)),
    };
  }

  #getTokenBucket(key: string, now: number): TokenBucketState {
    let state = this.#tokenBuckets.get(key);

    if (state === undefined) {
      state = {
        tokens: this.#options.burst,
        updatedAt: now,
      };
      this.#tokenBuckets.set(key, state);
    }

    return state;
  }

  #getSlidingWindow(key: string): SlidingWindowState {
    let state = this.#slidingWindows.get(key);

    if (state === undefined) {
      state = { timestamps: [] };
      this.#slidingWindows.set(key, state);
    }

    return state;
  }
}

function normalizeOptions(options: unknown): NormalizedRateLimiterOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Rate limiter options must be an object.", {
      field: "rateLimiter",
    });
  }

  const candidate = options as Partial<RateLimiterOptions>;
  const strategy = candidate.strategy ?? "token-bucket";
  const onLimit = candidate.onLimit ?? "reject";

  validateStrategy(strategy);
  validateIntegerAtLeast(candidate.limit, 1, "rateLimiter.limit");
  validateNumberGreaterThan(candidate.intervalMs, 0, "rateLimiter.intervalMs");

  if (candidate.burst !== undefined) {
    validateIntegerAtLeast(candidate.burst, 1, "rateLimiter.burst");

    if (strategy === "sliding-window") {
      throw new ConfigurationError("rateLimiter.burst is only supported for token-bucket.", {
        field: "rateLimiter.burst",
      });
    }
  }

  if (candidate.maxWaitMs !== undefined) {
    throw new ConfigurationError("rateLimiter.maxWaitMs is not implemented yet.", {
      field: "rateLimiter.maxWaitMs",
    });
  }

  validateOnLimit(onLimit);

  if (onLimit === "wait") {
    throw new ConfigurationError("rateLimiter wait mode is not implemented yet.", {
      field: "rateLimiter.onLimit",
    });
  }

  if (candidate.key !== undefined) {
    validateKey(candidate.key);
  }

  return Object.freeze({
    strategy,
    limit: candidate.limit,
    intervalMs: candidate.intervalMs,
    burst: candidate.burst ?? candidate.limit,
    onLimit,
    ...(candidate.key === undefined ? {} : { key: candidate.key }),
  });
}

function resolveKey(key: string | KeyResolver | undefined, ctx: Context): string {
  const resolved = key === undefined ? ctx.serviceName : typeof key === "function" ? key(ctx) : key;

  validateResolvedKey(resolved);

  return resolved;
}

function validateStrategy(strategy: unknown): asserts strategy is RateLimiterStrategy {
  if (strategy !== "token-bucket" && strategy !== "sliding-window") {
    throw new ConfigurationError(
      "rateLimiter.strategy must be 'token-bucket' or 'sliding-window'.",
      {
        field: "rateLimiter.strategy",
      },
    );
  }
}

function validateOnLimit(onLimit: unknown): asserts onLimit is RateLimiterLimitBehavior {
  if (onLimit !== "reject" && onLimit !== "wait") {
    throw new ConfigurationError("rateLimiter.onLimit must be 'reject' or 'wait'.", {
      field: "rateLimiter.onLimit",
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
    throw new ConfigurationError("rateLimiter.key must resolve to a non-empty string.", {
      field: "rateLimiter.key",
    });
  }
}
