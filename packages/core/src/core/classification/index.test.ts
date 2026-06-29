import { describe, expect, it } from "vitest";

import { createContext, type Context } from "../context";
import {
  AbortError,
  BulkheadRejectedError,
  CircuitOpenError,
  RateLimitExceededError,
  TimeoutError,
} from "../errors";
import { composeClassifier, httpClassifier, type FailureVerdict, type Outcome } from "./index";

describe("httpClassifier", () => {
  it.each([
    [200, false, false],
    [204, false, false],
    [301, false, false],
    [400, false, false],
    [404, false, false],
    [408, true, true],
    [409, false, false],
    [422, false, false],
    [429, false, true],
    [500, true, true],
    [502, true, true],
    [503, true, true],
    [504, true, true],
  ] as const)(
    "classifies HTTP status %s as failure=%s retryable=%s",
    (status, expectedFailure, expectedRetryable) => {
      const ctx = createTestContext();
      const outcome = success({ status });

      expect(httpClassifier.isFailure(outcome, ctx)).toBe(expectedFailure);
      expect(httpClassifier.isRetryable(outcome, ctx)).toBe(expectedRetryable);
    },
  );

  it("ignores success values without an HTTP status", () => {
    const ctx = createTestContext();
    const outcome = success({ ok: true });

    expect(httpClassifier.isFailure(outcome, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(outcome, ctx)).toBe(false);
  });

  it("ignores non-integer HTTP-like statuses", () => {
    const ctx = createTestContext();
    const outcome = success({ status: 500.5 });

    expect(httpClassifier.isFailure(outcome, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(outcome, ctx)).toBe(false);
  });

  it("classifies timeout errors as failure and retryable", () => {
    const ctx = createTestContext();
    const outcome = failure(new TimeoutError({ timeoutMs: 100 }));

    expect(httpClassifier.isFailure(outcome, ctx)).toBe(true);
    expect(httpClassifier.isRetryable(outcome, ctx)).toBe(true);
  });

  it("classifies caller aborts as terminal", () => {
    const ctx = createTestContext();
    const resiliAbort = failure(new AbortError({ reason: "caller" }));
    const nativeAbort = new Error("aborted");
    nativeAbort.name = "AbortError";

    expect(httpClassifier.isFailure(resiliAbort, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(resiliAbort, ctx)).toBe(false);
    expect(httpClassifier.isFailure(failure(nativeAbort), ctx)).toBe(false);
    expect(httpClassifier.isRetryable(failure(nativeAbort), ctx)).toBe(false);
  });

  it("classifies circuit-open errors as terminal", () => {
    const ctx = createTestContext();
    const outcome = failure(new CircuitOpenError({ key: "users", retryAfterMs: 500 }));

    expect(httpClassifier.isFailure(outcome, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(outcome, ctx)).toBe(false);
  });

  it("classifies local saturation errors according to the architecture defaults", () => {
    const ctx = createTestContext();
    const bulkhead = failure(new BulkheadRejectedError({ maxConcurrent: 1, queueSize: 0 }));
    const rateLimit = failure(new RateLimitExceededError({ retryAfterMs: 250 }));

    expect(httpClassifier.isFailure(bulkhead, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(bulkhead, ctx)).toBe(true);
    expect(httpClassifier.isFailure(rateLimit, ctx)).toBe(false);
    expect(httpClassifier.isRetryable(rateLimit, ctx)).toBe(true);
  });

  it("counts network errors but retries them only for idempotent operations", () => {
    const nonIdempotent = createTestContext();
    const idempotent = createTestContext({ idempotent: true });
    const outcome = failure(errorWithCode("ECONNRESET"));

    expect(httpClassifier.isFailure(outcome, nonIdempotent)).toBe(true);
    expect(httpClassifier.isRetryable(outcome, nonIdempotent)).toBe(false);
    expect(httpClassifier.isFailure(outcome, idempotent)).toBe(true);
    expect(httpClassifier.isRetryable(outcome, idempotent)).toBe(true);
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "EPIPE"] as const)(
    "treats %s as an idempotent retryable network error",
    (code) => {
      const ctx = createTestContext({ idempotent: true });
      const outcome = failure(errorWithCode(code));

      expect(httpClassifier.isFailure(outcome, ctx)).toBe(true);
      expect(httpClassifier.isRetryable(outcome, ctx)).toBe(true);
    },
  );

  it("classifies unknown errors safely", () => {
    const ctx = createTestContext();

    expect(httpClassifier.isFailure(failure(new Error("unknown")), ctx)).toBe(true);
    expect(httpClassifier.isRetryable(failure(new Error("unknown")), ctx)).toBe(false);
    expect(httpClassifier.isFailure(failure("unknown"), ctx)).toBe(false);
    expect(httpClassifier.isRetryable(failure("unknown"), ctx)).toBe(false);
  });

  it("returns retry-after hints from response headers", () => {
    const ctx = createTestContext();
    const headersLike = {
      get(name: string): string | null {
        return name === "retry-after" ? "2" : null;
      },
    };

    expect(httpClassifier.retryAfter?.(success({ status: 429, headers: headersLike }), ctx)).toBe(
      2_000,
    );
    expect(
      httpClassifier.retryAfter?.(
        success({ status: 429, headers: new Map([["retry-after", "3"]]) }),
        ctx,
      ),
    ).toBe(3_000);
    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: { "retry-after": "4" } }), ctx),
    ).toBe(4_000);
  });

  it("returns deterministic retry-after hints from HTTP dates", () => {
    const ctx = createTestContext(undefined, Date.UTC(2026, 0, 1, 0, 0, 0));
    const retryAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toUTCString();

    expect(
      httpClassifier.retryAfter?.(
        success({ status: 503, headers: { "Retry-After": retryAt } }),
        ctx,
      ),
    ).toBe(5_000);
  });

  it("normalizes past and invalid retry-after dates", () => {
    const ctx = createTestContext(undefined, Date.UTC(2026, 0, 1, 0, 0, 0));
    const past = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toUTCString();

    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: { "retry-after": past } }), ctx),
    ).toBe(0);
    expect(
      httpClassifier.retryAfter?.(
        success({ status: 429, headers: { "retry-after": "invalid" } }),
        ctx,
      ),
    ).toBeUndefined();
    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: { "retry-after": "-1" } }), ctx),
    ).toBeUndefined();
    expect(httpClassifier.retryAfter?.(success({ status: 429 }), ctx)).toBeUndefined();
  });

  it("ignores malformed retry-after header containers", () => {
    const ctx = createTestContext();

    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: null }), ctx),
    ).toBeUndefined();
    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: "2" }), ctx),
    ).toBeUndefined();
    expect(
      httpClassifier.retryAfter?.(success({ status: 429, headers: { "retry-after": 2 } }), ctx),
    ).toBeUndefined();
  });

  it("returns retry-after hints from Resili flow-control errors", () => {
    const ctx = createTestContext();

    expect(
      httpClassifier.retryAfter?.(failure(new RateLimitExceededError({ retryAfterMs: 123 })), ctx),
    ).toBe(123);
    expect(
      httpClassifier.retryAfter?.(
        failure(new CircuitOpenError({ key: "users", retryAfterMs: 456 })),
        ctx,
      ),
    ).toBe(456);
    expect(httpClassifier.retryAfter?.(failure(new Error("none")), ctx)).toBeUndefined();
  });

  it("is immutable", () => {
    expect(Object.isFrozen(httpClassifier)).toBe(true);
  });
});

describe("composeClassifier", () => {
  it("delegates to the base classifier when overrides are missing", () => {
    const ctx = createTestContext();
    const classifier = composeClassifier(httpClassifier, {});
    const outcome = success({ status: 500 });

    expect(classifier.isFailure(outcome, ctx)).toBe(true);
    expect(classifier.isRetryable(outcome, ctx)).toBe(true);
    expect(classifier.retryAfter?.(outcome, ctx)).toBeUndefined();
  });

  it("applies method-specific overrides independently", () => {
    const ctx = createTestContext();
    const classifier = composeClassifier(httpClassifier, {
      isFailure: () => false,
      retryAfter: () => 42,
    });
    const outcome = success({ status: 500 });

    expect(classifier.isFailure(outcome, ctx)).toBe(false);
    expect(classifier.isRetryable(outcome, ctx)).toBe(true);
    expect(classifier.retryAfter?.(outcome, ctx)).toBe(42);
  });

  it("uses retry-after fallback when an override returns undefined", () => {
    const ctx = createTestContext();
    const classifier = composeClassifier(httpClassifier, {
      retryAfter: () => undefined,
    });

    expect(
      classifier.retryAfter?.(success({ status: 429, headers: { "retry-after": "5" } }), ctx),
    ).toBe(5_000);
  });

  it("returns an immutable classifier", () => {
    const classifier = composeClassifier(httpClassifier, {});

    expect(Object.isFrozen(classifier)).toBe(true);
  });

  it("supports the FailureVerdict public shape", () => {
    const verdict: FailureVerdict = {
      failure: true,
      retryable: false,
      retryAfterMs: 10,
    };

    expect(verdict).toEqual({ failure: true, retryable: false, retryAfterMs: 10 });
  });
});

function success<T>(value: T): Outcome<T> {
  return { status: "success", value, durationMs: 1 };
}

function failure(error: unknown): Outcome {
  return { status: "error", error, durationMs: 1 };
}

function createTestContext(
  metadata?: Readonly<Record<string, unknown>>,
  startedAt = Date.UTC(2026, 0, 1, 0, 0, 0),
): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    metadata,
    startedAt,
  });
}

function errorWithCode(code: string): Error & { readonly code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;

  return error;
}
