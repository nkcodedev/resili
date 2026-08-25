import type { Context } from "../../core/context";
import { AbortError, ConfigurationError, RateLimitExceededError } from "../../core/errors";
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
   *
   * `"reject"` fails immediately. `"wait"` waits for capacity up to
   * {@link RateLimiterOptions.maxWaitMs}, then rejects if the remaining wait
   * would exceed that budget. Waiters for the same key are admitted FIFO.
   */
  readonly onLimit?: RateLimiterLimitBehavior;

  /**
   * Maximum wait duration for wait mode.
   *
   * Required when {@link RateLimiterOptions.onLimit} is `"wait"`. If the next
   * token would not become available within this remaining budget, the request
   * is rejected immediately instead of sleeping past the limit.
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
  readonly onLimit: RateLimiterLimitBehavior;
  readonly maxWaitMs?: number;
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
        await limiter.acquire(ctx);

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
  readonly #keyLocks = new Map<string, Promise<void>>();

  constructor(services: PolicyServices, options: NormalizedRateLimiterOptions) {
    this.#services = services;
    this.#options = options;
  }

  async acquire(ctx: Context): Promise<void> {
    const key = resolveKey(this.#options.key, ctx);

    if (this.#options.onLimit === "reject") {
      this.#acquireOrThrow(ctx, key, false);

      return;
    }

    await this.#withKeyLock(key, async () => {
      await this.#waitForAdmission(ctx, key);
    });
  }

  async #waitForAdmission(ctx: Context, key: string): Promise<void> {
    const maxWaitMs = this.#options.maxWaitMs ?? 0;
    const waitDeadline = this.#services.clock.now() + maxWaitMs;
    let waited = false;
    let announcedLimit = false;

    for (;;) {
      if (ctx.signal.aborted) {
        throw createAbortError(ctx);
      }

      const now = this.#services.clock.now();
      const result = this.#tryAcquire(key, now);

      if (result.allowed) {
        return;
      }

      const remainingWaitMs = waitDeadline - now;

      if (!announcedLimit) {
        this.#emitRateLimited(ctx, key, now, result.retryAfterMs, false);
        announcedLimit = true;
      }

      if (result.retryAfterMs > remainingWaitMs) {
        if (waited) {
          this.#emitRateLimited(ctx, key, now, result.retryAfterMs, true);
        }

        throw new RateLimitExceededError({
          retryAfterMs: result.retryAfterMs,
          context: ctx.snapshot(),
        });
      }

      await sleep(this.#services, result.retryAfterMs, ctx);
      waited = true;
    }
  }

  #acquireOrThrow(ctx: Context, key: string, waited: boolean): void {
    const now = this.#services.clock.now();
    const result = this.#tryAcquire(key, now);

    if (result.allowed) {
      return;
    }

    this.#emitRateLimited(ctx, key, now, result.retryAfterMs, waited);

    throw new RateLimitExceededError({
      retryAfterMs: result.retryAfterMs,
      context: ctx.snapshot(),
    });
  }

  #emitRateLimited(
    ctx: Context,
    key: string,
    timestamp: number,
    retryAfterMs: number,
    waited: boolean,
  ): void {
    this.#services.emit({
      type: "RateLimited",
      timestamp,
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
      strategy: this.#options.strategy,
      retryAfterMs,
      waited,
    });
  }

  #tryAcquire(
    key: string,
    now: number,
  ): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
    return this.#options.strategy === "token-bucket"
      ? this.#acquireTokenBucket(key, now)
      : this.#acquireSlidingWindow(key, now);
  }

  async #withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#keyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.#keyLocks.set(key, current);

    try {
      await previous.catch(() => undefined);

      return await fn();
    } finally {
      release();

      if (this.#keyLocks.get(key) === current) {
        this.#keyLocks.delete(key);
      }
    }
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
    validateNumberGreaterThan(candidate.maxWaitMs, 0, "rateLimiter.maxWaitMs");
  }

  validateOnLimit(onLimit);

  if (onLimit === "wait" && candidate.maxWaitMs === undefined) {
    throw new ConfigurationError("rateLimiter.maxWaitMs is required when onLimit is 'wait'.", {
      field: "rateLimiter.maxWaitMs",
    });
  }

  if (onLimit === "reject" && candidate.maxWaitMs !== undefined) {
    throw new ConfigurationError(
      "rateLimiter.maxWaitMs is only supported when onLimit is 'wait'.",
      {
        field: "rateLimiter.maxWaitMs",
      },
    );
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
    ...(candidate.maxWaitMs === undefined ? {} : { maxWaitMs: candidate.maxWaitMs }),
    ...(candidate.key === undefined ? {} : { key: candidate.key }),
  });
}

function sleep(services: PolicyServices, delayMs: number, ctx: Context): Promise<void> {
  if (delayMs <= 0) {
    if (ctx.signal.aborted) {
      throw createAbortError(ctx);
    }

    return Promise.resolve();
  }

  if (ctx.signal.aborted) {
    throw createAbortError(ctx);
  }

  return new Promise((resolve, reject) => {
    const timer = services.clock.setTimeout(() => {
      ctx.signal.removeEventListener("abort", onAbort);
      services.clock.clearTimeout(timer);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      services.clock.clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      reject(createAbortError(ctx));
    };

    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(ctx: Context): Error {
  const reason: unknown = ctx.signal.reason;

  return reason instanceof Error ? reason : new AbortError({ reason, context: ctx.snapshot() });
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
