import { AbortError } from "@resili/core";
import { LlmError } from "@resili/llm";
import { APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";

import { isAbortLike, mapOpenAiError } from "./errors";

describe("OpenAI abort detection (RESILI-INTEROP-001)", () => {
  it("recognizes real openai APIUserAbortError where .name === Error", () => {
    const error = new APIUserAbortError();

    // openai@7 does not assign this.name; Error.prototype leaves .name as "Error".
    expect(error.name).toBe("Error");
    expect(error.constructor.name).toBe("APIUserAbortError");
    expect(isAbortLike(error)).toBe(true);
  });

  it("does not treat an ordinary Error as cancellation", () => {
    const error = new Error("socket explode");

    expect(error.name).toBe("Error");
    expect(isAbortLike(error)).toBe(false);
  });

  it("still recognizes native AbortError and name-forged APIUserAbortError", () => {
    expect(isAbortLike(new AbortError())).toBe(true);
    expect(isAbortLike(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isAbortLike(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }))).toBe(
      true,
    );
  });

  it("normalizes APIUserAbortError to Core AbortError / ERR_ABORTED", () => {
    const sdkError = new APIUserAbortError();

    try {
      mapOpenAiError(sdkError, "gpt-4.1-mini");
      expect.unreachable("expected mapOpenAiError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AbortError);
      expect(error).toMatchObject({ code: "ERR_ABORTED" });
      expect((error as AbortError).reason).toBe(sdkError);
      expect((error as AbortError).cause).toBe(sdkError);
    }
  });

  it("maps ordinary unknown OpenAI failures to LlmError unknown, not AbortError", () => {
    try {
      mapOpenAiError(new Error("boom"), "gpt-4.1-mini");
      expect.unreachable("expected mapOpenAiError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ classification: "unknown", code: "ERR_LLM_UNKNOWN" });
      expect(error).not.toBeInstanceOf(AbortError);
    }
  });

  it("preserves authentication / rate-limit / server classifications", () => {
    expectMapped(
      Object.assign(new Error("401"), { name: "AuthenticationError", status: 401 }),
      "authentication",
    );
    expectMapped(
      Object.assign(new Error("429"), { name: "RateLimitError", status: 429 }),
      "rate_limited",
    );
    expectMapped(
      Object.assign(new Error("500"), { name: "InternalServerError", status: 500 }),
      "provider_unavailable",
    );
  });
});

function expectMapped(error: unknown, classification: string): void {
  try {
    mapOpenAiError(error, "gpt-4.1-mini");
    expect.unreachable("expected mapOpenAiError to throw");
  } catch (mapped) {
    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ classification });
  }
}
