/* eslint-disable @typescript-eslint/require-await */
import { ConfigurationError } from "@resili/core";
import { describe, expect, it, vi } from "vitest";

import type { Context } from "@resili/core";
import { defineProvider, normalizeUsage } from "./provider";

describe("defineProvider", () => {
  it("returns a frozen provider that executes successfully", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        provider: "example",
        model: "model-a",
        content: "ok",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        finishReason: "stop" as const,
      }),
    );
    const provider = defineProvider({
      name: "example",
      execute,
    });

    expect(Object.isFrozen(provider)).toBe(true);

    const ctx = { signal: new AbortController().signal } as Context;
    const response = await provider.execute(
      { provider: "example", model: "model-a", input: "hi" },
      ctx,
    );

    expect(response.content).toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("binds an optional stream method", async () => {
    const stream = vi.fn(async () => {
      return {
        async *[Symbol.asyncIterator]() {
          yield { text: "x" };
        },
      };
    });
    const provider = defineProvider({
      name: "example",
      execute: () =>
        Promise.resolve({
          provider: "example",
          model: "model-a",
          content: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        }),
      stream,
    });

    expect(typeof provider.stream).toBe("function");
    await provider.stream?.({ provider: "example", model: "model-a", input: "hi" }, {
      signal: new AbortController().signal,
    } as Context);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid provider", () => {
    expect(() => defineProvider(null as never)).toThrow(ConfigurationError);
    expect(() =>
      defineProvider({ name: "", execute: () => Promise.reject(new Error("unused")) }),
    ).toThrow(ConfigurationError);
  });
});

describe("normalizeUsage", () => {
  it("normalizes input, output, and total tokens", () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("derives total when omitted and treats missing counts as zero", () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(normalizeUsage({ inputTokens: 8, outputTokens: 2 })).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
    });
  });

  it("treats negative and non-finite counts as zero", () => {
    expect(
      normalizeUsage({ inputTokens: -1, outputTokens: Number.NaN, totalTokens: Infinity }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});
