import type { Context } from "../../core/context";
import { ConfigurationError, TimeoutError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Per-attempt timeout policy options.
 *
 * @public
 */
export interface TimeoutOptions {
  /**
   * Maximum duration for one attempt in milliseconds.
   */
  readonly perAttemptMs: number;

  /**
   * Optional overall budget across all attempts.
   *
   * The timeout policy validates this value but does not apply whole-request
   * deadline behavior; root context deadlines own that responsibility.
   */
  readonly deadlineMs?: number;
}

/**
 * Built-in timeout policy factory.
 *
 * Pass a number shorthand or {@link TimeoutOptions} as factory options.
 *
 * @public
 */
export const timeoutPolicy: PolicyFactory = definePolicy({
  name: "timeout",
  order: 400,
  create(services: PolicyServices, options?: unknown) {
    const timeoutOptions = normalizeOptions(options);

    return {
      name: "timeout",
      order: 400,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithTimeout(ctx, next, services, timeoutOptions);
      },
    };
  },
});

function executeWithTimeout<T>(
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  options: TimeoutOptions,
): Promise<T> {
  const timeoutController = new AbortController();
  const childContext = ctx.fork({
    attemptNumber: ctx.attemptNumber,
    signal: timeoutController.signal,
  });
  let settled = false;
  let rejectTimeout!: (error: TimeoutError) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = services.clock.setTimeout(() => {
    if (settled) {
      return;
    }

    const error = new TimeoutError({
      timeoutMs: options.perAttemptMs,
      attemptNumber: childContext.attemptNumber,
      context: childContext.snapshot(),
    });

    timeoutController.abort(error);
    services.emit({
      type: "TimeoutTriggered",
      timestamp: services.clock.now(),
      requestId: childContext.requestId,
      operationName: childContext.operationName,
      serviceName: childContext.serviceName,
      attemptNumber: childContext.attemptNumber,
      timeoutMs: options.perAttemptMs,
    });
    rejectTimeout(error);
  }, options.perAttemptMs);

  return Promise.race([Promise.resolve().then(() => next(childContext)), timeout]).finally(() => {
    settled = true;
    services.clock.clearTimeout(timer);
  });
}

function normalizeOptions(options: unknown): TimeoutOptions {
  if (typeof options === "number") {
    validatePositiveFinite(options, "timeout.perAttemptMs");

    return Object.freeze({ perAttemptMs: options });
  }

  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Timeout options must be a number or object.", {
      field: "timeout",
    });
  }

  const candidate = options as Partial<TimeoutOptions>;

  validatePositiveFinite(candidate.perAttemptMs, "timeout.perAttemptMs");

  if (candidate.deadlineMs !== undefined) {
    validatePositiveFinite(candidate.deadlineMs, "timeout.deadlineMs");

    if (candidate.deadlineMs < candidate.perAttemptMs) {
      throw new ConfigurationError(
        "timeout.deadlineMs must be greater than or equal to perAttemptMs.",
        {
          field: "timeout.deadlineMs",
        },
      );
    }
  }

  return Object.freeze(
    candidate.deadlineMs === undefined
      ? { perAttemptMs: candidate.perAttemptMs }
      : { perAttemptMs: candidate.perAttemptMs, deadlineMs: candidate.deadlineMs },
  );
}

function validatePositiveFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${field} must be a positive finite number.`, { field });
  }
}
