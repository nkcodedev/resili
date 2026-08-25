import type { Context } from "../../core/context";
import { BulkheadRejectedError, ConfigurationError } from "../../core/errors";
import {
  definePolicy,
  type KeyResolver,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

export type { KeyResolver } from "../../core/policy";

/**
 * Bulkhead admission-control options.
 *
 * @public
 */
export interface BulkheadOptions {
  /**
   * Maximum concurrent executions admitted for one key.
   */
  readonly maxConcurrent: number;

  /**
   * Maximum queued executions for one key.
   */
  readonly maxQueue?: number;

  /**
   * Maximum queue wait in milliseconds.
   */
  readonly queueTimeoutMs?: number;

  /**
   * Static key or resolver. Defaults to `ctx.serviceName`.
   */
  readonly key?: string | KeyResolver;
}

interface BulkheadState {
  active: number;
  readonly queue: QueuedRequest[];
}

interface QueuedRequest {
  readonly enqueuedAt: number;
  readonly resolve: () => void;
  readonly reject: (error: BulkheadRejectedError) => void;
  timer?: ReturnType<typeof globalThis.setTimeout>;
  settled: boolean;
}

interface NormalizedBulkheadOptions {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number;
  readonly key?: string | KeyResolver;
}

/**
 * Built-in bulkhead policy factory.
 *
 * Pass a number shorthand or {@link BulkheadOptions} as factory options.
 *
 * @public
 */
export const bulkheadPolicy: PolicyFactory = definePolicy({
  name: "bulkhead",
  order: 600,
  create(services: PolicyServices, options?: unknown) {
    const bulkheadOptions = normalizeOptions(options);
    const semaphore = new BulkheadSemaphore(services, bulkheadOptions);

    return {
      name: "bulkhead",
      order: 600,
      async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        const key = resolveKey(bulkheadOptions.key, ctx);
        const permit = await semaphore.acquire(key, ctx);

        try {
          return await next(ctx);
        } finally {
          permit.release();
        }
      },
    };
  },
});

class BulkheadSemaphore {
  readonly #services: PolicyServices;
  readonly #options: NormalizedBulkheadOptions;
  readonly #states = new Map<string, BulkheadState>();

  constructor(services: PolicyServices, options: BulkheadOptions) {
    this.#services = services;
    this.#options = {
      maxConcurrent: options.maxConcurrent,
      maxQueue: options.maxQueue ?? 0,
      queueTimeoutMs: options.queueTimeoutMs ?? 0,
      ...(options.key === undefined ? {} : { key: options.key }),
    };
  }

  async acquire(key: string, ctx: Context): Promise<{ readonly release: () => void }> {
    const state = this.#getState(key);

    if (state.active < this.#options.maxConcurrent) {
      state.active += 1;

      return Object.freeze({
        release: () => {
          this.#release(key);
        },
      });
    }

    if (state.queue.length >= this.#options.maxQueue) {
      const error = this.#createRejectedError(ctx, key, state.queue.length, 0);
      this.#emitRejected(ctx, key, state.queue.length, 0);

      throw error;
    }

    await this.#enqueue(key, ctx, state);

    return Object.freeze({
      release: () => {
        this.#release(key);
      },
    });
  }

  #enqueue(key: string, ctx: Context, state: BulkheadState): Promise<void> {
    const enqueuedAt = this.#services.clock.now();

    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        enqueuedAt,
        resolve,
        reject,
        settled: false,
      };

      if (this.#options.queueTimeoutMs > 0) {
        request.timer = this.#services.clock.setTimeout(() => {
          if (request.settled) {
            return;
          }

          request.settled = true;
          removeQueuedRequest(state.queue, request);

          const waitedMs = Math.max(0, this.#services.clock.now() - enqueuedAt);
          const queueSize = state.queue.length;
          const error = this.#createRejectedError(ctx, key, queueSize, waitedMs);

          this.#emitRejected(ctx, key, queueSize, waitedMs);
          reject(error);
        }, this.#options.queueTimeoutMs);
      }

      state.queue.push(request);
    });
  }

  #release(key: string): void {
    const state = this.#states.get(key);

    if (state === undefined) {
      return;
    }

    state.active = Math.max(0, state.active - 1);

    while (state.queue.length > 0 && state.active < this.#options.maxConcurrent) {
      const request = state.queue.shift();

      if (request === undefined || request.settled) {
        continue;
      }

      request.settled = true;
      if (request.timer !== undefined) {
        this.#services.clock.clearTimeout(request.timer);
      }

      state.active += 1;
      request.resolve();
      break;
    }

    if (state.active === 0 && state.queue.length === 0) {
      this.#states.delete(key);
    }
  }

  #getState(key: string): BulkheadState {
    let state = this.#states.get(key);

    if (state === undefined) {
      state = { active: 0, queue: [] };
      this.#states.set(key, state);
    }

    return state;
  }

  #createRejectedError(
    ctx: Context,
    key: string,
    queueSize: number,
    waitedMs: number,
  ): BulkheadRejectedError {
    void key;

    return new BulkheadRejectedError({
      maxConcurrent: this.#options.maxConcurrent,
      queueSize,
      waitedMs,
      context: ctx.snapshot(),
    });
  }

  #emitRejected(ctx: Context, key: string, queueSize: number, waitedMs: number): void {
    this.#services.emit({
      type: "BulkheadRejected",
      timestamp: this.#services.clock.now(),
      requestId: ctx.requestId,
      operationName: ctx.operationName,
      serviceName: ctx.serviceName,
      key,
      maxConcurrent: this.#options.maxConcurrent,
      queueSize,
      waitedMs,
    });
  }
}

function normalizeOptions(options: unknown): BulkheadOptions {
  if (typeof options === "number") {
    validateIntegerAtLeast(options, 1, "bulkhead.maxConcurrent");

    return Object.freeze({ maxConcurrent: options });
  }

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Bulkhead options must be a number or object.", {
      field: "bulkhead",
    });
  }

  const candidate = options as Partial<BulkheadOptions>;

  validateIntegerAtLeast(candidate.maxConcurrent, 1, "bulkhead.maxConcurrent");

  if (candidate.maxQueue !== undefined) {
    validateIntegerAtLeast(candidate.maxQueue, 0, "bulkhead.maxQueue");
  }

  if (candidate.queueTimeoutMs !== undefined) {
    validateNumberAtLeast(candidate.queueTimeoutMs, 0, "bulkhead.queueTimeoutMs");

    if (candidate.queueTimeoutMs > 0 && (candidate.maxQueue ?? 0) === 0) {
      throw new ConfigurationError("bulkhead.queueTimeoutMs requires maxQueue greater than 0.", {
        field: "bulkhead.queueTimeoutMs",
      });
    }
  }

  if (candidate.key !== undefined) {
    validateKey(candidate.key);
  }

  return Object.freeze({
    maxConcurrent: candidate.maxConcurrent,
    ...(candidate.maxQueue === undefined ? {} : { maxQueue: candidate.maxQueue }),
    ...(candidate.queueTimeoutMs === undefined ? {} : { queueTimeoutMs: candidate.queueTimeoutMs }),
    ...(candidate.key === undefined ? {} : { key: candidate.key }),
  });
}

function resolveKey(key: string | KeyResolver | undefined, ctx: Context): string {
  const resolved = key === undefined ? ctx.serviceName : typeof key === "function" ? key(ctx) : key;

  validateResolvedKey(resolved);

  return resolved;
}

function removeQueuedRequest(queue: QueuedRequest[], request: QueuedRequest): void {
  const index = queue.indexOf(request);

  if (index >= 0) {
    queue.splice(index, 1);
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

function validateKey(key: string | KeyResolver): void {
  if (typeof key === "function") {
    return;
  }

  validateResolvedKey(key);
}

function validateResolvedKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError("bulkhead.key must resolve to a non-empty string.", {
      field: "bulkhead.key",
    });
  }
}
