/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/non-nullable-type-assertion-style */
import { createLlmClient, LlmError } from "@resili/llm";
import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_SDK_MAX_RETRIES,
  createAnthropicProvider,
  type AnthropicClient,
  type AnthropicRequestOptions,
  type AnthropicStreamEvent,
} from "./index";

const MODEL = "claude-sonnet-4-5";

function mockClient(
  create: (
    body: { readonly stream?: boolean },
    options?: AnthropicRequestOptions,
  ) => Promise<AsyncIterable<AnthropicStreamEvent>>,
): AnthropicClient {
  return {
    messages: {
      create: create as AnthropicClient["messages"]["create"],
    },
  };
}

function events(values: readonly AnthropicStreamEvent[]): AsyncIterable<AnthropicStreamEvent> {
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
          return { done: false, value: value as AnthropicStreamEvent };
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("Anthropic streaming adapter", () => {
  it("normalizes text_delta, usage, stop reason, retries, and signal", async () => {
    const create = vi.fn((body, options?: AnthropicRequestOptions) => {
      expect(body.stream).toBe(true);
      expect(options?.maxRetries).toBe(ANTHROPIC_SDK_MAX_RETRIES);
      expect(options?.signal).toBeInstanceOf(AbortSignal);

      return Promise.resolve(
        events([
          {
            type: "message_start",
            message: { model: MODEL, usage: { input_tokens: 8, output_tokens: 0 } },
          },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
        ]),
      );
    });
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(create),
        model: MODEL,
        maxTokens: 64,
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
        expect(event.usage.inputTokens).toBe(8);
        expect(event.usage.outputTokens).toBe(2);
      }
    }

    expect(texts).toEqual(["Hi"]);
    await llm.destroy();
  });

  it("retries pre-commit and not post-commit", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(() => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(Object.assign(new Error("429"), { status: 429 }));
          }
          return Promise.resolve(
            events([{ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }]),
          );
        }),
        model: MODEL,
        maxTokens: 64,
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
      provider: createAnthropicProvider({
        client: mockClient(() => {
          committed += 1;
          return Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
              throw Object.assign(new Error("529"), { status: 529 });
            },
          });
        }),
        model: MODEL,
        maxTokens: 64,
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
