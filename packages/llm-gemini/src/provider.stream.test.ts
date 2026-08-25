/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/non-nullable-type-assertion-style */
import { createLlmClient, LlmError } from "@resili/llm";
import { describe, expect, it, vi } from "vitest";

import {
  createGeminiProvider,
  GEMINI_SDK_HTTP_ATTEMPTS,
  type GeminiClient,
  type GeminiGenerateContentParameters,
  type GeminiGenerateContentResponse,
} from "./index";
import { incrementalVisibleText } from "./provider";

const MODEL = "gemini-2.5-flash";

function mockClient(
  generateContentStream: (
    params: GeminiGenerateContentParameters,
  ) => Promise<AsyncIterable<GeminiGenerateContentResponse>>,
): GeminiClient {
  return {
    models: {
      generateContent: () => Promise.reject(new Error("unary unused")),
      generateContentStream,
    },
  };
}

function streamOf(
  values: readonly GeminiGenerateContentResponse[],
): AsyncIterable<GeminiGenerateContentResponse> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= values.length) {
            return { done: true, value: undefined };
          }
          const value = values[index];
          index += 1;
          return { done: false, value: value as GeminiGenerateContentResponse };
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("Gemini streaming adapter", () => {
  it("emits only new text for cumulative chunks", async () => {
    expect(incrementalVisibleText("", "Hello")).toBe("Hello");
    expect(incrementalVisibleText("Hello", "Hello world")).toBe(" world");
    expect(incrementalVisibleText("Hel", "lo")).toBe("lo");

    const generateContentStream = vi.fn((params: GeminiGenerateContentParameters) => {
      expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(params.config?.httpOptions?.retryOptions?.attempts).toBe(GEMINI_SDK_HTTP_ATTEMPTS);

      return Promise.resolve(
        streamOf([
          {
            modelVersion: MODEL,
            candidates: [{ content: { parts: [{ text: "Hello" }] } }],
          },
          {
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hello world" }] } }],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 2,
              totalTokenCount: 4,
            },
          },
        ]),
      );
    });
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(generateContentStream),
        model: MODEL,
      }),
      model: MODEL,
    });

    const texts: string[] = [];
    for await (const event of llm.stream({ input: "Hello" })) {
      if (event.type === "text-delta") {
        texts.push(event.text);
      }
      if (event.type === "completed") {
        expect(event.finishReason).toBe("stop");
        expect(event.usage.totalTokens).toBe(4);
      }
    }

    expect(texts).toEqual(["Hello", " world"]);
    await llm.destroy();
  });

  it("retries pre-commit and not post-commit", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(() => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(Object.assign(new Error("429"), { status: 429 }));
          }
          return Promise.resolve(
            streamOf([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]),
          );
        }),
        model: MODEL,
      }),
      model: MODEL,
      retry: { maxAttempts: 2, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const texts: string[] = [];
    for await (const event of llm.stream({ input: "x" })) {
      if (event.type === "text-delta") {
        texts.push(event.text);
      }
    }
    expect(texts).toEqual(["ok"]);
    expect(attempts).toBe(2);

    let committed = 0;
    const failing = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(() => {
          committed += 1;
          return Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield { candidates: [{ content: { parts: [{ text: "Hello" }] } }] };
              throw Object.assign(new Error("unavailable"), { status: 503 });
            },
          });
        }),
        model: MODEL,
      }),
      model: MODEL,
      retry: { maxAttempts: 4, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    await expect(
      (async () => {
        for await (const event of failing.stream({ input: "x" })) {
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(LlmError);
    expect(committed).toBe(1);
    await llm.destroy();
    await failing.destroy();
  });
});
