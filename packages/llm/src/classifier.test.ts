import { describe, expect, it } from "vitest";

import type { Context } from "@resili/core";

import { llmClassifier } from "./classifier";
import { LlmError } from "./errors";

describe("llmClassifier status-retry safety", () => {
  const ctx = {
    metadata: new Map<string, unknown>(),
    startedAt: 0,
  } as unknown as Context;

  it("does not auto-retry successful HTTP-shaped values via the HTTP base classifier", () => {
    const outcome = {
      status: "success" as const,
      value: { status: 503, content: "x" },
      durationMs: 1,
    };

    expect(llmClassifier.isFailure(outcome, ctx)).toBe(true);
    expect(llmClassifier.isRetryable(outcome, ctx)).toBe(false);
  });

  it("still retries thrown retryable LlmError values", () => {
    const outcome = {
      status: "error" as const,
      error: new LlmError("overloaded", { provider: "test", model: "m" }),
      durationMs: 1,
    };

    expect(llmClassifier.isRetryable(outcome, ctx)).toBe(true);
  });
});
