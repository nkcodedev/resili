import type { Context } from "../context";
import {
  AbortError,
  BulkheadRejectedError,
  CircuitOpenError,
  RateLimitExceededError,
  TimeoutError,
} from "../errors";

/**
 * Result of one operation attempt.
 *
 * Classifiers inspect outcomes instead of raw thrown values so success values
 * such as HTTP `Response` objects and thrown errors can be evaluated through
 * the same deterministic contract.
 *
 * @public
 */
export type Outcome<T = unknown> =
  | {
      readonly status: "success";
      readonly value: T;
      readonly durationMs: number;
    }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly durationMs: number;
    };

/**
 * Classification result represented as the two independent classifier axes.
 *
 * @public
 */
export interface FailureVerdict {
  /**
   * Whether the outcome counts toward breaker failure rate and failure metrics.
   */
  readonly failure: boolean;

  /**
   * Whether the outcome is eligible for another retry attempt.
   */
  readonly retryable: boolean;

  /**
   * Optional retry delay hint in milliseconds.
   */
  readonly retryAfterMs?: number;
}

/**
 * Pure failure-classification contract used by retry and circuit-breaker
 * policies.
 *
 * Implementations must be side-effect free and should never throw for normal
 * classification decisions. Builders may replace the default classifier or
 * combine it with overrides through {@link composeClassifier}.
 *
 * @public
 */
export interface FailureClassifier {
  /**
   * Returns true when `outcome` should count against downstream health.
   */
  isFailure(outcome: Outcome, ctx: Context): boolean;

  /**
   * Returns true when `outcome` may be retried.
   */
  isRetryable(outcome: Outcome, ctx: Context): boolean;

  /**
   * Returns an optional retry delay hint in milliseconds.
   */
  retryAfter?(outcome: Outcome, ctx: Context): number | undefined;
}

/**
 * Default HTTP-oriented failure classifier.
 *
 * It treats `2xx`/`3xx` as success, `4xx` caller errors as terminal, `429` as
 * retryable backpressure, `5xx` and timeouts as downstream failures, and network
 * errors as retryable only for idempotent operations.
 *
 * @public
 */
export const httpClassifier: FailureClassifier = Object.freeze({
  isFailure(outcome: Outcome, ctx: Context): boolean {
    if (outcome.status === "success") {
      const status = getStatus(outcome.value);

      return status !== undefined && isHttpFailureStatus(status);
    }

    return isErrorFailure(outcome.error, ctx);
  },

  isRetryable(outcome: Outcome, ctx: Context): boolean {
    if (outcome.status === "success") {
      const status = getStatus(outcome.value);

      return status !== undefined && isRetryableHttpStatus(status);
    }

    return isErrorRetryable(outcome.error, ctx);
  },

  retryAfter(outcome: Outcome, ctx: Context): number | undefined {
    if (outcome.status === "success") {
      return getRetryAfterMs(outcome.value, ctx.startedAt);
    }

    if (outcome.error instanceof RateLimitExceededError) {
      return outcome.error.retryAfterMs;
    }

    if (outcome.error instanceof CircuitOpenError) {
      return outcome.error.retryAfterMs;
    }

    return undefined;
  },
});

/**
 * Composes a base classifier with partial overrides.
 *
 * Overrides are evaluated independently per method. Missing methods delegate to
 * `base`, preserving the default behavior without requiring users to re-create
 * the entire classifier.
 *
 * @public
 */
export function composeClassifier(
  base: FailureClassifier,
  overrides: Partial<FailureClassifier>,
): FailureClassifier {
  return Object.freeze({
    isFailure(outcome: Outcome, ctx: Context): boolean {
      return overrides.isFailure?.(outcome, ctx) ?? base.isFailure(outcome, ctx);
    },

    isRetryable(outcome: Outcome, ctx: Context): boolean {
      return overrides.isRetryable?.(outcome, ctx) ?? base.isRetryable(outcome, ctx);
    },

    retryAfter(outcome: Outcome, ctx: Context): number | undefined {
      return overrides.retryAfter?.(outcome, ctx) ?? base.retryAfter?.(outcome, ctx);
    },
  });
}

function isHttpFailureStatus(status: number): boolean {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isErrorFailure(error: unknown, ctx: Context): boolean {
  if (
    error instanceof AbortError ||
    error instanceof CircuitOpenError ||
    error instanceof BulkheadRejectedError ||
    error instanceof RateLimitExceededError
  ) {
    return false;
  }

  if (error instanceof TimeoutError) {
    return true;
  }

  return isNetworkError(error) || isUnknownNonAbortError(error, ctx);
}

function isErrorRetryable(error: unknown, ctx: Context): boolean {
  if (error instanceof TimeoutError || error instanceof BulkheadRejectedError) {
    return true;
  }

  if (error instanceof RateLimitExceededError) {
    return true;
  }

  if (error instanceof AbortError || error instanceof CircuitOpenError) {
    return false;
  }

  if (isNetworkError(error)) {
    return isIdempotent(ctx);
  }

  return false;
}

function isUnknownNonAbortError(error: unknown, _ctx: Context): boolean {
  void _ctx;

  return error instanceof Error && getErrorName(error) !== "AbortError";
}

function isNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);

  return (
    code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EPIPE"
  );
}

function isIdempotent(ctx: Context): boolean {
  return ctx.metadata.get("idempotent") === true;
}

function getStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return undefined;
  }

  const status = (value as { readonly status: unknown }).status;

  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function getRetryAfterMs(value: unknown, nowMs: number): number | undefined {
  const headerValue = getHeaderValue(value, "retry-after");

  if (headerValue === undefined) {
    return undefined;
  }

  const trimmedHeaderValue = headerValue.trim();
  const seconds = Number(trimmedHeaderValue);

  if (trimmedHeaderValue.length > 0 && Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1_000 : undefined;
  }

  const epochMs = Date.parse(trimmedHeaderValue);

  if (!Number.isFinite(epochMs)) {
    return undefined;
  }

  const delayMs = epochMs - nowMs;

  return delayMs > 0 ? delayMs : 0;
}

function getHeaderValue(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) {
    return undefined;
  }

  const headers = (value as { readonly headers: unknown }).headers;

  if (headers === undefined || headers === null) {
    return undefined;
  }

  if (headers instanceof Map) {
    const headerMap = headers as ReadonlyMap<string, unknown>;
    const result: unknown = headerMap.get(name) ?? headerMap.get(name.toLowerCase());

    return typeof result === "string" ? result : undefined;
  }

  if (typeof headers === "object" && "get" in headers) {
    const get = (headers as { readonly get: unknown }).get;

    if (typeof get === "function") {
      const result: unknown = get.call(headers, name);

      return typeof result === "string" ? result : undefined;
    }
  }

  if (typeof headers === "object") {
    const headerRecord = headers as Readonly<Record<string, unknown>>;
    const result =
      headerRecord[name] ?? headerRecord[name.toLowerCase()] ?? headerRecord["Retry-After"];

    return typeof result === "string" ? result : undefined;
  }

  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { readonly code: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

function getErrorName(error: Error): string {
  return error.name;
}
