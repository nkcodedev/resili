import { describe, expect, it } from "vitest";

import type { ContextSnapshot } from "../context";
import {
  AbortError,
  BulkheadRejectedError,
  CircuitOpenError,
  ConfigurationError,
  RateLimitExceededError,
  ResiliError,
  RetryExceededError,
  TimeoutError,
  isResiliError,
  type ResiliErrorCode,
} from "./index";

const context: ContextSnapshot = Object.freeze({
  requestId: "req-1",
  operationName: "getUser",
  serviceName: "users",
  attemptNumber: 2,
});

describe("ResiliError hierarchy", () => {
  it("preserves inheritance, instanceof, code, context, cause, name, and stack", () => {
    const cause = new Error("invalid value");
    const error = new ConfigurationError("Retry maxAttempts must be greater than zero.", {
      cause,
      context,
      field: "retry.maxAttempts",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ResiliError);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.name).toBe("ConfigurationError");
    expect(error.message).toBe("Retry maxAttempts must be greater than zero.");
    expect(error.code).toBe("ERR_CONFIG");
    expect(error.isResili).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.context).toBe(context);
    expect(error.field).toBe("retry.maxAttempts");
    expect(error.stack).toEqual(expect.stringContaining("ConfigurationError"));
  });

  it("supports cross-realm style guarding with isResiliError", () => {
    const error = new ConfigurationError("Invalid config.");
    const structural = { isResili: true, code: "ERR_CONFIG" };

    expect(isResiliError(error)).toBe(true);
    expect(isResiliError(structural)).toBe(true);
    expect(isResiliError(new Error("plain"))).toBe(false);
    expect(isResiliError({ isResili: false, code: "ERR_CONFIG" })).toBe(false);
    expect(isResiliError({ isResili: true, code: 1 })).toBe(false);
    expect(isResiliError({ isResili: true, code: "ERR_UNKNOWN" })).toBe(false);
    expect(isResiliError(null)).toBe(false);
  });

  it("retains stable string-literal error codes", () => {
    const codes: ResiliErrorCode[] = [
      "ERR_CONFIG",
      "ERR_CIRCUIT_OPEN",
      "ERR_TIMEOUT",
      "ERR_RETRY_EXCEEDED",
      "ERR_BULKHEAD_FULL",
      "ERR_RATE_LIMITED",
      "ERR_ABORTED",
    ];

    expect(codes).toHaveLength(7);
  });

  it("is JSON serializable through enumerable public properties", () => {
    const error = new TimeoutError({ timeoutMs: 250, attemptNumber: 3, context });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      isResili: true,
      context,
      code: "ERR_TIMEOUT",
      timeoutMs: 250,
      attemptNumber: 3,
    });
  });
});

describe("specific Resili errors", () => {
  it("creates ConfigurationError with optional field", () => {
    const error = new ConfigurationError("Invalid configuration.");

    expect(error.code).toBe("ERR_CONFIG");
    expect(error.field).toBeUndefined();
  });

  it("creates CircuitOpenError", () => {
    const error = new CircuitOpenError({
      key: "payments",
      retryAfterMs: 30_000,
      context,
    });

    expect(error.code).toBe("ERR_CIRCUIT_OPEN");
    expect(error.key).toBe("payments");
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toBe(
      'Circuit "payments" is open. Requests are temporarily blocked until recovery.',
    );
    expect(error.context).toBe(context);
  });

  it("creates TimeoutError with and without attempt number", () => {
    const withAttempt = new TimeoutError({ timeoutMs: 500, attemptNumber: 4 });
    const withoutAttempt = new TimeoutError({ timeoutMs: 500 });

    expect(withAttempt.code).toBe("ERR_TIMEOUT");
    expect(withAttempt.timeoutMs).toBe(500);
    expect(withAttempt.attemptNumber).toBe(4);
    expect(withAttempt.message).toBe("Operation timed out after 500ms.");
    expect(withoutAttempt.attemptNumber).toBeUndefined();
  });

  it("creates RetryExceededError and preserves lastError as cause", () => {
    const lastError = new TimeoutError({ timeoutMs: 100 });
    const error = new RetryExceededError({ attempts: 3, lastError, context });

    expect(error.code).toBe("ERR_RETRY_EXCEEDED");
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(lastError);
    expect(error.cause).toBe(lastError);
    expect(error.context).toBe(context);
    expect(error.message).toBe("Retry attempts exhausted after 3 attempt(s).");
  });

  it("creates RetryExceededError with unknown lastError", () => {
    const error = new RetryExceededError({ attempts: 1, lastError: "boom" });

    expect(error.lastError).toBe("boom");
    expect(error.cause).toBe("boom");
  });

  it("creates BulkheadRejectedError with default and explicit wait time", () => {
    const defaultWait = new BulkheadRejectedError({ maxConcurrent: 10, queueSize: 5 });
    const explicitWait = new BulkheadRejectedError({
      maxConcurrent: 10,
      queueSize: 5,
      waitedMs: 25,
      context,
    });

    expect(defaultWait.code).toBe("ERR_BULKHEAD_FULL");
    expect(defaultWait.maxConcurrent).toBe(10);
    expect(defaultWait.queueSize).toBe(5);
    expect(defaultWait.waitedMs).toBe(0);
    expect(defaultWait.message).toBe("Bulkhead is full. Request was rejected before execution.");
    expect(explicitWait.waitedMs).toBe(25);
    expect(explicitWait.context).toBe(context);
  });

  it("creates RateLimitExceededError", () => {
    const error = new RateLimitExceededError({ retryAfterMs: 750, context });

    expect(error.code).toBe("ERR_RATE_LIMITED");
    expect(error.retryAfterMs).toBe(750);
    expect(error.context).toBe(context);
    expect(error.message).toBe("Rate limit exceeded. Retry after 750ms.");
  });

  it("creates AbortError with reason as cause", () => {
    const reason = new DOMException("Caller cancelled.", "AbortError");
    const error = new AbortError({ reason, context });

    expect(error.code).toBe("ERR_ABORTED");
    expect(error.reason).toBe(reason);
    expect(error.cause).toBe(reason);
    expect(error.context).toBe(context);
    expect(error.message).toBe("Operation was aborted.");
  });

  it("creates AbortError with explicit cause overriding reason", () => {
    const reason = "user";
    const cause = new Error("external cancellation");
    const error = new AbortError({ reason, cause });

    expect(error.reason).toBe(reason);
    expect(error.cause).toBe(cause);
  });

  it("creates AbortError without reason", () => {
    const error = new AbortError();

    expect(error.reason).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});

describe("stack trace fallback", () => {
  it("works when Error.captureStackTrace is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Error, "captureStackTrace");

    try {
      Error.captureStackTrace = undefined;

      const error = new ConfigurationError("Invalid configuration.");

      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.stack).toEqual(expect.any(String));
    } finally {
      if (descriptor === undefined) {
        delete Error.captureStackTrace;
      } else {
        Object.defineProperty(Error, "captureStackTrace", descriptor);
      }
    }
  });
});
