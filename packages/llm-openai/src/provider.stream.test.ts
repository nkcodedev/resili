/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/non-nullable-type-assertion-style */
import { createLlmClient, LlmError } from "@resili/llm";
import type { Clock } from "@resili/core";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenAiProvider,
  OPENAI_SDK_MAX_RETRIES,
  type OpenAiChatCompletionChunk,
  type OpenAiClient,
  type OpenAiRequestOptions,
} from "./index";

function mockClient(
  create: (
    body: { readonly stream?: boolean; readonly stream_options?: unknown },
    options?: OpenAiRequestOptions,
  ) => Promise<AsyncIterable<OpenAiChatCompletionChunk>>,
): OpenAiClient {
  return {
    chat: {
      completions: {
        create: create as OpenAiClient["chat"]["completions"]["create"],
      },
    },
  };
}

function chunks(
  values: readonly OpenAiChatCompletionChunk[],
  onNext?: () => void,
  onReturn?: () => void,
): AsyncIterable<OpenAiChatCompletionChunk> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          onNext?.();
          if (index >= values.length) {
            return { done: true, value: undefined };
          }
          const value = values[index];
          index += 1;
          return { done: false, value: value as OpenAiChatCompletionChunk };
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("OpenAI streaming adapter", () => {
  it("normalizes text, usage, finish reason, disables SDK retries, and honors signal", async () => {
    const create = vi.fn((body, options?: OpenAiRequestOptions) => {
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(options?.maxRetries).toBe(OPENAI_SDK_MAX_RETRIES);
      expect(options?.signal).toBeInstanceOf(AbortSignal);

      return Promise.resolve(
        chunks([
          { model: "gpt-4.1-mini", choices: [{ delta: { content: "Hi" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        ]),
      );
    });
    const llm = createLlmClient({
      provider: createOpenAiProvider({ client: mockClient(create), model: "gpt-4.1-mini" }),
      model: "gpt-4.1-mini",
    });

    const texts: string[] = [];
    for await (const event of llm.stream({ input: "Hello" })) {
      if (event.type === "text-delta") {
        texts.push(event.text);
      }
      if (event.type === "completed") {
        expect(event.finishReason).toBe("stop");
        expect(event.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
        expect(event.model).toBe("gpt-4.1-mini");
      }
    }

    expect(texts).toEqual(["Hi"]);
    await llm.destroy();
  });

  it("retries pre-commit failures and not post-commit failures", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient((_body, options?: OpenAiRequestOptions) => {
          void options;
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(Object.assign(new Error("429"), { status: 429 }));
          }
          return Promise.resolve(chunks([{ choices: [{ delta: { content: "ok" } }] }]));
        }),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
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

    let committedAttempts = 0;
    const failing = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient(() => {
          committedAttempts += 1;
          return Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "Hello" } }] };
              throw Object.assign(new Error("503"), { status: 503 });
            },
          });
        }),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
      retry: { maxAttempts: 4, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    await expect(
      (async () => {
        for await (const event of failing.stream({ input: "x" })) {
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(LlmError);
    expect(committedAttempts).toBe(1);
    await llm.destroy();
    await failing.destroy();
  });

  it("maps SDK errors thrown from iterator.next() after the stream is open", async () => {
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient(() =>
          Promise.resolve({
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<OpenAiChatCompletionChunk>> {
                  return Promise.reject(
                    Object.assign(new Error("429"), { status: 429, name: "RateLimitError" }),
                  );
                },
              };
            },
          }),
        ),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
      retry: { maxAttempts: 1 },
    });

    await expect(
      (async () => {
        for await (const event of llm.stream({ input: "x" })) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({ lastError: { classification: "rate_limited" } });
    await llm.destroy();
  });

  it("does not retry after the first OpenAI text-delta when the stream times out", async () => {
    let creates = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient(() => {
          creates += 1;
          return Promise.resolve({
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                async next(): Promise<IteratorResult<OpenAiChatCompletionChunk>> {
                  index += 1;
                  if (index === 1) {
                    return {
                      done: false,
                      value: { choices: [{ delta: { content: "A1" } }] },
                    };
                  }
                  return new Promise(() => undefined);
                },
              };
            },
          });
        }),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const texts: string[] = [];
    const iterator = llm.stream({ input: "x" })[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.value?.type === "text-delta") {
      texts.push(first.value.text);
    }
    const pending = iterator.next();
    clock.tick(40);
    await expect(pending).rejects.toMatchObject({ classification: "timeout", retryable: false });
    expect(creates).toBe(1);
    expect(texts).toEqual(["A1"]);
    expect(retryStarted).toBe(0);
    await llm.destroy();
  });

  it("propagates cancellation through iterator.return", async () => {
    let returned = 0;
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient(() =>
          Promise.resolve(
            chunks(
              [
                { choices: [{ delta: { content: "a" } }] },
                { choices: [{ delta: { content: "b" } }] },
              ],
              undefined,
              () => {
                returned += 1;
              },
            ),
          ),
        ),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
    });

    for await (const event of llm.stream({ input: "x" })) {
      if (event.type === "text-delta") {
        break;
      }
    }

    expect(returned).toBeGreaterThanOrEqual(1);
    await llm.destroy();
  });
});

class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + ms, callback });
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    this.#timers.delete(handle as number);
  }

  tick(ms: number): void {
    this.#now += ms;
    for (const [handle, timer] of [...this.#timers].sort(
      ([leftHandle], [rightHandle]) => leftHandle - rightHandle,
    )) {
      if (timer.at <= this.#now && this.#timers.delete(handle)) {
        timer.callback();
      }
    }
  }
}
