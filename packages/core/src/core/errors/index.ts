import type { ContextSnapshot } from "../context";

/**
 * Stable machine-readable error codes used by Resili errors.
 *
 * These string-literal codes are intentionally used instead of TypeScript
 * enums to preserve the public API decision in `API_SPECIFICATION.md`.
 *
 * @public
 */
export type ResiliErrorCode =
  | "ERR_CONFIG"
  | "ERR_CIRCUIT_OPEN"
  | "ERR_TIMEOUT"
  | "ERR_RETRY_EXCEEDED"
  | "ERR_BULKHEAD_FULL"
  | "ERR_RATE_LIMITED"
  | "ERR_ABORTED";

const RESILI_ERROR_CODES = new Set<string>([
  "ERR_CONFIG",
  "ERR_CIRCUIT_OPEN",
  "ERR_TIMEOUT",
  "ERR_RETRY_EXCEEDED",
  "ERR_BULKHEAD_FULL",
  "ERR_RATE_LIMITED",
  "ERR_ABORTED",
]);

/**
 * Options shared by Resili error constructors.
 *
 * @public
 */
export interface ResiliErrorOptions {
  readonly cause?: unknown;
  readonly context?: ContextSnapshot;
}

/**
 * Base class for every Resili error.
 *
 * `ResiliError` preserves the original ES2022 `cause`, carries a stable
 * machine-readable `code`, and optionally includes the request context snapshot
 * available at the point the error was created.
 *
 * @public
 */
export abstract class ResiliError extends Error {
  /**
   * Stable machine-readable error code.
   */
  abstract readonly code: ResiliErrorCode;

  /**
   * Cross-realm marker used by {@link isResiliError}.
   */
  readonly isResili = true;

  /**
   * Lightweight snapshot of the request context when available.
   */
  readonly context?: ContextSnapshot;

  protected constructor(message: string, options: ResiliErrorOptions = {}) {
    super(message, { cause: options.cause });

    Object.defineProperty(this, "name", {
      value: new.target.name,
      configurable: true,
      writable: true,
    });
    if (options.context !== undefined) {
      this.context = options.context;
    }

    Object.setPrototypeOf(this, new.target.prototype);

    const captureStackTrace: unknown = Object.getOwnPropertyDescriptor(
      Error,
      "captureStackTrace",
    )?.value;

    if (isCaptureStackTrace(captureStackTrace)) {
      captureStackTrace(this, new.target);
    }
  }
}

function isCaptureStackTrace(
  value: unknown,
): value is (targetObject: object, constructorOpt?: unknown) => void {
  return typeof value === "function";
}

function createCauseOptions(
  cause: unknown,
  context: ContextSnapshot | undefined,
): ResiliErrorOptions {
  if (context === undefined) {
    return { cause };
  }

  return { cause, context };
}

/**
 * Returns true when a value is a Resili error.
 *
 * Prefer this guard over `instanceof` across package or module boundaries where
 * more than one copy of the package may be loaded.
 *
 * @public
 */
export function isResiliError(error: unknown): error is ResiliError {
  return (
    typeof error === "object" &&
    error !== null &&
    "isResili" in error &&
    (error as { readonly isResili: unknown }).isResili === true &&
    "code" in error &&
    typeof (error as { readonly code: unknown }).code === "string" &&
    RESILI_ERROR_CODES.has((error as { readonly code: string }).code)
  );
}

/**
 * Thrown when builder or configuration validation fails.
 *
 * @public
 */
export class ConfigurationError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_CONFIG";

  /**
   * Optional configuration field associated with the failure.
   */
  readonly field?: string;

  constructor(message: string, options: ResiliErrorOptions & { readonly field?: string } = {}) {
    super(message, options);
    if (options.field !== undefined) {
      this.field = options.field;
    }
  }
}

/**
 * Thrown when a circuit breaker is open and rejects a call before execution.
 *
 * @public
 */
export class CircuitOpenError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_CIRCUIT_OPEN";

  /**
   * Circuit partition key that rejected the request.
   */
  readonly key: string;

  /**
   * Milliseconds until the next recovery probe may be attempted.
   */
  readonly retryAfterMs: number;

  constructor(
    options: ResiliErrorOptions & { readonly key: string; readonly retryAfterMs: number },
  ) {
    super(
      `Circuit "${options.key}" is open. Requests are temporarily blocked until recovery.`,
      options,
    );
    this.key = options.key;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Thrown when the per-attempt timeout elapses.
 *
 * @public
 */
export class TimeoutError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_TIMEOUT";

  /**
   * Configured per-attempt timeout in milliseconds.
   */
  readonly timeoutMs: number;

  /**
   * One-based attempt number that timed out.
   */
  readonly attemptNumber?: number;

  constructor(
    options: ResiliErrorOptions & { readonly timeoutMs: number; readonly attemptNumber?: number },
  ) {
    super(`Operation timed out after ${String(options.timeoutMs)}ms.`, options);
    this.timeoutMs = options.timeoutMs;
    if (options.attemptNumber !== undefined) {
      this.attemptNumber = options.attemptNumber;
    }
  }
}

/**
 * Thrown when retry attempts or retry budget are exhausted.
 *
 * @public
 */
export class RetryExceededError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_RETRY_EXCEEDED";

  /**
   * Total attempts executed before exhaustion.
   */
  readonly attempts: number;

  /**
   * Last error observed by the retry policy.
   */
  readonly lastError: unknown;

  constructor(
    options: Omit<ResiliErrorOptions, "cause"> & {
      readonly attempts: number;
      readonly lastError: unknown;
    },
  ) {
    super(
      `Retry attempts exhausted after ${String(options.attempts)} attempt(s).`,
      createCauseOptions(options.lastError, options.context),
    );
    this.attempts = options.attempts;
    this.lastError = options.lastError;
  }
}

/**
 * Thrown when the bulkhead cannot admit a request.
 *
 * @public
 */
export class BulkheadRejectedError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_BULKHEAD_FULL";

  /**
   * Configured maximum active executions.
   */
  readonly maxConcurrent: number;

  /**
   * Queue size at rejection time.
   */
  readonly queueSize: number;

  /**
   * Milliseconds spent waiting before rejection.
   */
  readonly waitedMs: number;

  constructor(
    options: ResiliErrorOptions & {
      readonly maxConcurrent: number;
      readonly queueSize: number;
      readonly waitedMs?: number;
    },
  ) {
    super("Bulkhead is full. Request was rejected before execution.", options);
    this.maxConcurrent = options.maxConcurrent;
    this.queueSize = options.queueSize;
    this.waitedMs = options.waitedMs ?? 0;
  }
}

/**
 * Thrown when rate-limit admission fails.
 *
 * @public
 */
export class RateLimitExceededError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_RATE_LIMITED";

  /**
   * Milliseconds until a retry may be attempted.
   */
  readonly retryAfterMs: number;

  constructor(options: ResiliErrorOptions & { readonly retryAfterMs: number }) {
    super(`Rate limit exceeded. Retry after ${String(options.retryAfterMs)}ms.`, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Thrown when caller cancellation or the overall deadline aborts execution.
 *
 * This is intentionally distinct from {@link TimeoutError}: timeout is treated
 * as a downstream failure, while abort is caller intent.
 *
 * @public
 */
export class AbortError extends ResiliError {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "ERR_ABORTED";

  /**
   * Original abort reason when available.
   */
  readonly reason?: unknown;

  constructor(options: ResiliErrorOptions & { readonly reason?: unknown } = {}) {
    super(
      "Operation was aborted.",
      createCauseOptions(options.cause ?? options.reason, options.context),
    );
    this.reason = options.reason;
  }
}
