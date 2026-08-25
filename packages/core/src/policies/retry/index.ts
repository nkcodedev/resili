import type { Outcome } from "../../core/classification";
import type { Context } from "../../core/context";
import { ConfigurationError, isResiliError, RetryExceededError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Predicate used to decide whether an outcome should be retried.
 *
 * @public
 */
export type RetryPredicate = (outcome: Outcome, ctx: Context) => boolean;

/**
 * Retry backoff strategy.
 *
 * @public
 */
export type RetryBackoff = "fixed" | "exponential";

/**
 * Retry jitter strategy.
 *
 * @public
 */
export type RetryJitter = "none";

/**
 * Retry policy options.
 *
 * @public
 */
export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly backoff?: RetryBackoff;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxTotalDelayMs?: number;
  readonly jitter?: RetryJitter;
  readonly factor?: number;
  readonly retryOn?: RetryPredicate;
  readonly respectRetryAfter?: boolean;
}

interface NormalizedRetryOptions {
  readonly maxAttempts: number;
  readonly backoff: RetryBackoff;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxTotalDelayMs: number;
  readonly jitter: "none";
  readonly factor: number;
  readonly respectRetryAfter: boolean;
  readonly retryOn?: RetryPredicate;
}

/**
 * Built-in retry policy factory.
 *
 * Pass {@link RetryOptions} as factory options.
 *
 * @public
 */
export const retryPolicy: PolicyFactory = definePolicy({
  name: "retry",
  order: 200,
  create(services: PolicyServices, options?: unknown) {
    const retryOptions = normalizeOptions(options);

    return {
      name: "retry",
      order: 200,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithRetry(ctx, next, services, retryOptions);
      },
    };
  },
});

async function executeWithRetry<T>(
  rootContext: Context,
  next: Next<T>,
  services: PolicyServices,
  options: NormalizedRetryOptions,
): Promise<T> {
  let attemptNumber = rootContext.attemptNumber;
  let totalDelayMs = 0;
  let lastError: unknown;

  for (;;) {
    const attemptContext =
      attemptNumber === rootContext.attemptNumber
        ? rootContext
        : rootContext.fork({ attemptNumber });
    const startedAt = services.clock.now();

    try {
      const value = await next(attemptContext);
      const outcome: Outcome<T> = Object.freeze({
        status: "success",
        value,
        durationMs: Math.max(0, services.clock.now() - startedAt),
      });

      if (!shouldRetry(outcome, attemptContext, services, options)) {
        if (attemptNumber > rootContext.attemptNumber) {
          emitRetryCompleted(services, rootContext, attemptNumber, totalDelayMs);
        }

        return value;
      }

      lastError = new Error("Retry predicate requested retry for successful outcome.");
    } catch (error) {
      const outcome: Outcome = Object.freeze({
        status: "error",
        error,
        durationMs: Math.max(0, services.clock.now() - startedAt),
      });

      lastError = error;

      if (!shouldRetry(outcome, attemptContext, services, options)) {
        throw error;
      }
    }

    const nextAttempt = attemptNumber + 1;

    if (nextAttempt - rootContext.attemptNumber + 1 > options.maxAttempts) {
      emitRetryFailed(services, rootContext, attemptNumber, lastError);
      throw new RetryExceededError({
        attempts: attemptNumber - rootContext.attemptNumber + 1,
        lastError,
        context: rootContext.snapshot(),
      });
    }

    const outcomeForDelay: Outcome = Object.freeze({
      status: "error",
      error: lastError,
      durationMs: 0,
    });
    const delayMs = resolveDelayMs(
      outcomeForDelay,
      attemptContext,
      services,
      options,
      attemptNumber - rootContext.attemptNumber,
    );

    if (totalDelayMs + delayMs > options.maxTotalDelayMs) {
      emitRetryFailed(services, rootContext, attemptNumber, lastError);
      throw new RetryExceededError({
        attempts: attemptNumber - rootContext.attemptNumber + 1,
        lastError,
        context: rootContext.snapshot(),
      });
    }

    totalDelayMs += delayMs;
    emitRetryStarted(services, rootContext, nextAttempt, delayMs, lastError);
    await sleep(services, delayMs);
    attemptNumber = nextAttempt;
  }
}

function shouldRetry(
  outcome: Outcome,
  ctx: Context,
  services: PolicyServices,
  options: NormalizedRetryOptions,
): boolean {
  return options.retryOn?.(outcome, ctx) ?? services.classifier.isRetryable(outcome, ctx);
}

function resolveDelayMs(
  outcome: Outcome,
  ctx: Context,
  services: PolicyServices,
  options: NormalizedRetryOptions,
  retryIndex: number,
): number {
  if (options.respectRetryAfter) {
    const retryAfterMs = services.classifier.retryAfter?.(outcome, ctx);

    if (retryAfterMs !== undefined) {
      return Math.min(options.maxDelayMs, Math.max(0, retryAfterMs));
    }
  }

  const rawDelay =
    options.backoff === "fixed"
      ? options.baseDelayMs
      : options.baseDelayMs * options.factor ** retryIndex;

  return Math.min(options.maxDelayMs, rawDelay);
}

function sleep(services: PolicyServices, delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = services.clock.setTimeout(() => {
      services.clock.clearTimeout(timer);
      resolve();
    }, delayMs);
  });
}

function emitRetryStarted(
  services: PolicyServices,
  ctx: Context,
  attemptNumber: number,
  delayMs: number,
  reason: unknown,
): void {
  services.emit({
    type: "RetryStarted",
    timestamp: services.clock.now(),
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    attemptNumber,
    delayMs,
    ...(isResiliError(reason) ? { reason: reason.code } : {}),
  });
}

function emitRetryCompleted(
  services: PolicyServices,
  ctx: Context,
  attempts: number,
  totalDelayMs: number,
): void {
  services.emit({
    type: "RetryCompleted",
    timestamp: services.clock.now(),
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    attempts,
    totalDelayMs,
  });
}

function emitRetryFailed(
  services: PolicyServices,
  ctx: Context,
  attempts: number,
  lastError: unknown,
): void {
  services.emit({
    type: "RetryFailed",
    timestamp: services.clock.now(),
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    attempts,
    ...(isResiliError(lastError) ? { lastErrorCode: lastError.code } : {}),
  });
}

function normalizeOptions(options: unknown): NormalizedRetryOptions {
  if (options === undefined) {
    return DEFAULT_OPTIONS;
  }

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Retry options must be an object.", { field: "retry" });
  }

  const candidate = options as Partial<RetryOptions>;
  const maxAttempts = candidate.maxAttempts ?? 3;
  const backoff = candidate.backoff ?? "exponential";
  const baseDelayMs = candidate.baseDelayMs ?? 100;
  const maxDelayMs = candidate.maxDelayMs ?? 10_000;
  const maxTotalDelayMs = candidate.maxTotalDelayMs ?? 30_000;
  const jitter = (candidate as { readonly jitter?: unknown }).jitter ?? "none";
  const factor = candidate.factor ?? 2;
  const respectRetryAfter = candidate.respectRetryAfter ?? true;
  const idempotentOnly = (candidate as { readonly idempotentOnly?: unknown }).idempotentOnly;

  validateIntegerAtLeast(maxAttempts, 1, "retry.maxAttempts");
  validateBackoff(backoff);
  validateNumberAtLeast(baseDelayMs, 0, "retry.baseDelayMs");
  validateNumberAtLeast(maxDelayMs, baseDelayMs, "retry.maxDelayMs");
  validateNumberAtLeast(maxTotalDelayMs, 0, "retry.maxTotalDelayMs");
  validateJitter(jitter);
  validateNumberAtLeast(factor, 1, "retry.factor");
  validateBoolean(respectRetryAfter, "retry.respectRetryAfter");

  if (backoff === "fixed" && candidate.factor !== undefined) {
    throw new ConfigurationError("retry.factor is only valid for exponential backoff.", {
      field: "retry.factor",
    });
  }

  if (jitter !== "none") {
    throw new ConfigurationError("retry jitter modes other than 'none' are not implemented.", {
      field: "retry.jitter",
    });
  }

  if (idempotentOnly !== undefined) {
    validateBoolean(idempotentOnly, "retry.idempotentOnly");

    if (idempotentOnly) {
      throw new ConfigurationError("retry.idempotentOnly is not implemented.", {
        field: "retry.idempotentOnly",
      });
    }
  }

  if (candidate.retryOn !== undefined && typeof candidate.retryOn !== "function") {
    throw new ConfigurationError("retry.retryOn must be a function.", { field: "retry.retryOn" });
  }

  return Object.freeze({
    maxAttempts,
    backoff,
    baseDelayMs,
    maxDelayMs,
    maxTotalDelayMs,
    jitter,
    factor,
    respectRetryAfter,
    ...(candidate.retryOn === undefined ? {} : { retryOn: candidate.retryOn }),
  });
}

const DEFAULT_OPTIONS: NormalizedRetryOptions = Object.freeze({
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  maxTotalDelayMs: 30_000,
  jitter: "none",
  factor: 2,
  respectRetryAfter: true,
});

function validateBackoff(value: unknown): asserts value is RetryBackoff {
  if (value !== "fixed" && value !== "exponential") {
    throw new ConfigurationError("retry.backoff must be 'fixed' or 'exponential'.", {
      field: "retry.backoff",
    });
  }
}

function validateJitter(value: unknown): asserts value is RetryJitter | "full" | "equal" {
  if (value !== "none" && value !== "full" && value !== "equal") {
    throw new ConfigurationError("retry.jitter must be 'none'.", {
      field: "retry.jitter",
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

function validateBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${field} must be a boolean.`, { field });
  }
}
