import { describe, expect, it } from "vitest";

import { isLlmError, isLlmErrorRetryable, LlmBudgetExceededError, LlmError } from "./errors";

describe("LlmError", () => {
  it("marks rate-limited and timeout errors as retryable", () => {
    const rateLimited = new LlmError("rate_limited", { cause: new Error("429") });
    const timeout = new LlmError("timeout");

    expect(rateLimited.retryable).toBe(true);
    expect(timeout.retryable).toBe(true);
    expect(isLlmErrorRetryable(rateLimited)).toBe(true);
    expect(rateLimited.cause).toBeInstanceOf(Error);
  });

  it("marks authentication and unknown errors as non-retryable", () => {
    const auth = new LlmError("authentication");
    const unknown = new LlmError("unknown");

    expect(auth.retryable).toBe(false);
    expect(unknown.retryable).toBe(false);
    expect(isLlmErrorRetryable(unknown)).toBe(false);
    expect(isLlmErrorRetryable(new Error("nope"))).toBe(false);
  });

  it("preserves the original cause", () => {
    const cause = new Error("upstream");
    const error = new LlmError("network_transient", { cause, provider: "example" });

    expect(error.cause).toBe(cause);
    expect(error.provider).toBe("example");
    expect(isLlmError(error)).toBe(true);
  });

  it("does not put secrets in the error message", () => {
    const error = new LlmError("authentication", {
      message: "LLM authentication failed.",
      cause: { headers: { authorization: "sk-secret" } },
    });

    expect(error.message).not.toContain("sk-secret");
  });
});

describe("LlmBudgetExceededError", () => {
  it("is a non-retryable LLM error", () => {
    const error = new LlmBudgetExceededError({
      scope: "example",
      limitKind: "per-request",
      limitMicroUsd: 100,
      accumulatedMicroUsd: 0,
      attemptedMicroUsd: 200,
    });

    expect(error).toBeInstanceOf(LlmError);
    expect(error.classification).toBe("budget");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("ERR_LLM_BUDGET");
  });
});
