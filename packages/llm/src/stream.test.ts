/* eslint-disable @typescript-eslint/require-await */
import {
  AbortError,
  ConfigurationError,
  RetryExceededError,
  TimeoutError,
  type Clock,
  type FailureClassifier,
  type Labels,
  type MetricsRecorder,
} from "@resili/core";
import { describe, expect, it } from "vitest";

import {
  createLlmClient,
  createMemoryBudgetAccountant,
  createPricingResolver,
  defineProvider,
  LLM_METRIC_NAMES,
  LlmError,
  isLlmError,
  type LlmEvent,
  type LlmProviderStreamFrame,
  type LlmResponse,
  type LlmStreamEvent,
} from "./index";
import { LLM_STREAM_COMMIT_STATE_KEY, type LlmStreamCommitState } from "./classifier";

const PROMPT = "SECRET_PROMPT_DO_NOT_EMIT";
const OUTPUT = "SECRET_STREAM_TEXT";

const pricing = createPricingResolver([
  {
    provider: "example",
    model: "model-a",
    inputPerMillionTokensUsd: 1,
    outputPerMillionTokensUsd: 5,
  },
]);

function successUsage(): LlmResponse["usage"] {
  return { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
}

function streamingProvider(
  frames: readonly LlmProviderStreamFrame[] | (() => AsyncIterable<LlmProviderStreamFrame>),
  options: {
    readonly execute?: () => Promise<LlmResponse>;
    readonly onStream?: () => void;
    readonly onIteratorReturn?: () => void;
    readonly nextCalls?: { count: number };
  } = {},
) {
  return defineProvider({
    name: "example",
    async execute() {
      if (options.execute !== undefined) {
        return options.execute();
      }

      return {
        provider: "example",
        model: "model-a",
        content: "unary",
        usage: successUsage(),
        finishReason: "stop",
      };
    },
    async stream() {
      options.onStream?.();
      const iterable = typeof frames === "function" ? frames() : iterate(frames, options);

      return iterable;
    },
  });
}

function iterate(
  frames: readonly LlmProviderStreamFrame[],
  options: {
    readonly onIteratorReturn?: () => void;
    readonly nextCalls?: { count: number };
  },
): AsyncIterable<LlmProviderStreamFrame> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmProviderStreamFrame> {
      let index = 0;

      return {
        async next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
          if (options.nextCalls !== undefined) {
            options.nextCalls.count += 1;
          }

          if (index >= frames.length) {
            return { done: true, value: undefined };
          }

          const value = frames[index];
          index += 1;
          if (value === undefined) {
            return { done: true, value: undefined };
          }
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
          options.onIteratorReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("LlmClient.stream", () => {
  it("rejects providers that do not implement stream", () => {
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          return {
            provider: "example",
            model: "model-a",
            content: "x",
            usage: successUsage(),
            finishReason: "stop",
          };
        },
      }),
      model: "model-a",
    });

    expect(() => llm.stream({ input: "Hello" })).toThrow(ConfigurationError);
  });

  it("does not open the provider stream until consumption begins", async () => {
    let opened = 0;
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: "pong" }, { finishReason: "stop", usage: successUsage() }],
        {
          onStream: () => {
            opened += 1;
          },
        },
      ),
      model: "model-a",
    });

    const stream = llm.stream({ input: "Hello" });
    expect(opened).toBe(0);

    await collect(stream);
    expect(opened).toBe(1);
    await llm.destroy();
  });

  it("yields text deltas, a completed event, and a matching result()", async () => {
    const llm = createLlmClient({
      provider: streamingProvider([
        { text: "Hel" },
        { text: "lo" },
        { finishReason: "stop", usage: successUsage(), model: "model-a" },
      ]),
      model: "model-a",
      pricing,
    });

    const stream = llm.stream({ input: "Hello" });
    const events = await collect(stream);
    const firstResult = await stream.result();
    const secondResult = await stream.result();

    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      expect.objectContaining({
        type: "completed",
        provider: "example",
        model: "model-a",
        finishReason: "stop",
        usage: successUsage(),
      }),
    ]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.cost?.totalCostMicroUsd).toBe(30);
    expect(events[2]).toMatchObject({
      usage: firstResult.usage,
      cost: firstResult.cost,
      finishReason: firstResult.finishReason,
    });
    await llm.destroy();
  });

  it("retries retryable failures before the first non-empty text and not after", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;

          if (attempts === 1) {
            throw new LlmError("overloaded");
          }

          return iterate([{ text: "pong" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const stream = llm.stream({ input: "Hello" });
    const events = await collect(stream);

    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "pong" },
    ]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    await expect(stream.result()).resolves.toMatchObject({ finishReason: "stop" });
    await llm.destroy();
  });

  it("does not commit on metadata or empty text, then retries", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;

          if (attempts === 1) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { model: "model-a" };
                yield { text: "" };
                yield { usage: { inputTokens: 1 } };
                throw new LlmError("rate_limited");
              },
            };
          }

          return iterate([{ text: "ok" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 2, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const events = await collect(llm.stream({ input: "Hello" }));
    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "ok" },
    ]);
    await llm.destroy();
  });

  it("does not retry after the first yielded non-empty text", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;
          return {
            async *[Symbol.asyncIterator]() {
              yield { text: "Hello " };
              yield { text: "world" };
              throw new LlmError("overloaded");
            },
          };
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 5, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const seen: string[] = [];
    const stream = llm.stream({ input: PROMPT });
    const events: LlmEvent[] = [];
    llm.on("LlmStreamFailed", (event) => events.push(event));

    await expect(
      (async () => {
        for await (const event of stream) {
          if (event.type === "text-delta") {
            seen.push(event.text);
          }
        }
      })(),
    ).rejects.toBeInstanceOf(LlmError);

    expect(seen.join("")).toBe("Hello world");
    expect(attempts).toBe(1);
    expect(events[0]).toMatchObject({ type: "LlmStreamFailed", committed: true, retryable: false });
    await expect(stream.result()).rejects.toBeInstanceOf(LlmError);
    await llm.destroy();
  });

  it("does not drain the provider iterator ahead of consumer pulls", async () => {
    const nextCalls = { count: 0 };
    const llm = createLlmClient({
      provider: streamingProvider(
        [
          { text: "a" },
          { text: "b" },
          { text: "c" },
          { finishReason: "stop", usage: successUsage() },
        ],
        { nextCalls },
      ),
      model: "model-a",
    });

    const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
    const first = await iterator.next();

    await Promise.resolve();
    await Promise.resolve();

    expect(first.value).toEqual({ type: "text-delta", text: "a" });
    expect(nextCalls.count).toBe(1);
    await iterator.return?.();
    await llm.destroy();
  });

  it("cancels the provider iterator on early break and rejects result()", async () => {
    let returned = 0;
    const nextCalls = { count: 0 };
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: "a" }, { text: "b" }, { finishReason: "stop", usage: successUsage() }],
        {
          onIteratorReturn: () => {
            returned += 1;
          },
          nextCalls,
        },
      ),
      model: "model-a",
    });

    const stream = llm.stream({ input: "Hello" });
    const seen: LlmStreamEvent[] = [];

    for await (const event of stream) {
      seen.push(event);
      if (event.type === "text-delta") {
        break;
      }
    }

    expect(seen).toEqual([{ type: "text-delta", text: "a" }]);
    expect(returned).toBeGreaterThanOrEqual(1);
    expect(nextCalls.count).toBe(1);
    await expect(stream.result()).rejects.toBeInstanceOf(AbortError);
    await llm.destroy();
  });

  it("aborts before first text and after first text", async () => {
    const before = new AbortController();
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: "late" }, { finishReason: "stop", usage: successUsage() }],
        {},
      ),
      model: "model-a",
    });

    before.abort();
    const early = llm.stream({ input: "Hello", signal: before.signal });
    await expect(collect(early)).rejects.toBeInstanceOf(Error);

    const after = new AbortController();
    const stream = llm.stream({ input: "Hello", signal: after.signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    after.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(Error);
    await llm.destroy();
  });

  it("treats timeout as the full stream attempt including consumer wait", async () => {
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: "a" }, { text: "b" }, { finishReason: "stop", usage: successUsage() }],
        {},
      ),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 1 },
    });

    const stream = llm.stream({ input: "Hello" });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    clock.tick(40);
    await expect(iterator.next()).rejects.toBeInstanceOf(Error);
    expect(clock.activeTimers).toBe(0);
    await llm.destroy();
  });

  it("settles Budget Guard reservations on success, error, abort, timeout, and early break", async () => {
    const run = async (
      scenario: "success" | "error" | "abort" | "timeout" | "break",
    ): Promise<number> => {
      const accountant = createMemoryBudgetAccountant();
      const clock = new FakeClock();
      const llm = createLlmClient({
        provider:
          scenario === "error"
            ? defineProvider({
                name: "example",
                async execute() {
                  throw new Error("unused");
                },
                async stream() {
                  throw new LlmError("overloaded", { retryable: false });
                },
              })
            : streamingProvider(
                [{ text: "a" }, { finishReason: "stop", usage: successUsage() }],
                {},
              ),
        model: "model-a",
        pricing,
        clock,
        timeout: { perAttemptMs: 30 },
        retry: { maxAttempts: 1 },
        budget: {
          maxAccumulatedCostUsd: 1,
          accountant,
        },
      });

      const stream = llm.stream({
        input: "Hello",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 4,
        ...(scenario === "abort" ? { signal: abortNow() } : {}),
      });

      try {
        if (scenario === "break") {
          for await (const event of stream) {
            if (event.type === "text-delta") {
              break;
            }
          }
          await stream.result().catch(() => undefined);
        } else if (scenario === "timeout") {
          const iterator = stream[Symbol.asyncIterator]();
          await iterator.next();
          clock.tick(30);
          await iterator.next();
        } else {
          await collect(stream);
          await stream.result().catch(() => undefined);
        }
      } catch {
        // expected for failure scenarios
      }

      await llm.destroy();
      return accountant.getReservedMicroUsd("example");
    };

    expect(await run("success")).toBe(0);
    expect(await run("error")).toBe(0);
    expect(await run("abort")).toBe(0);
    expect(await run("timeout")).toBe(0);
    expect(await run("break")).toBe(0);
  });

  it("emits stream telemetry without prompt or completion text", async () => {
    const events: LlmEvent[] = [];
    const metrics = createRecordingMetrics();
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: OUTPUT }, { finishReason: "stop", usage: successUsage() }],
        {},
      ),
      model: "model-a",
      pricing,
      metrics,
    });
    llm.on("LlmStreamStarted", (event) => events.push(event));
    llm.on("LlmStreamCompleted", (event) => events.push(event));

    await collect(llm.stream({ input: PROMPT }));
    const serialized = JSON.stringify(events);

    expect(events.map((event) => event.type)).toEqual(["LlmStreamStarted", "LlmStreamCompleted"]);
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain(OUTPUT);
    expect(metrics.counterValue(LLM_METRIC_NAMES.streams, { result: "success" })).toBe(1);
    expect(metrics.labelKeys()).toEqual(["result"]);
    await llm.destroy();
  });

  it("rejects result() when return() happens before the first next()", async () => {
    const llm = createLlmClient({
      provider: streamingProvider([{ text: "x" }, { finishReason: "stop", usage: successUsage() }]),
      model: "model-a",
    });

    const stream = llm.stream({ input: "Hello" });
    await stream[Symbol.asyncIterator]().return?.();
    await expect(stream.result()).rejects.toBeInstanceOf(AbortError);
    await llm.destroy();
  });

  it("rejects concurrent next() without starting a second provider stream", async () => {
    let opened = 0;
    const llm = createLlmClient({
      provider: streamingProvider(
        [{ text: "a" }, { text: "b" }, { finishReason: "stop", usage: successUsage() }],
        {
          onStream: () => {
            opened += 1;
          },
        },
      ),
      model: "model-a",
    });

    const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toBeInstanceOf(LlmError);
    await first;
    expect(opened).toBe(1);
    await iterator.return?.();
    await llm.destroy();
  });

  it("does not change unary generate() behavior", async () => {
    const llm = createLlmClient({
      provider: streamingProvider([], {
        execute: async () => ({
          provider: "example",
          model: "model-a",
          content: "unary-ok",
          usage: successUsage(),
          finishReason: "stop",
        }),
      }),
      model: "model-a",
      pricing,
    });

    const result = await llm.generate({ input: "Hello" });
    expect(result.response.content).toBe("unary-ok");
    await llm.destroy();
  });

  it("still retries unary generate() timeouts (stream commit does not apply)", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          attempts += 1;
          return new Promise<LlmResponse>(() => undefined);
        },
      }),
      model: "model-a",
      timeout: { perAttemptMs: 20 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(RetryExceededError);
    expect(attempts).toBe(3);
    expect(retryStarted).toBe(2);
    await llm.destroy();
  });

  it("retries a pre-commit provider 429 and then succeeds", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;
          if (attempts === 1) {
            throw new LlmError("rate_limited");
          }
          return iterate([{ text: "ok" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const texts = await collectTexts(llm.stream({ input: "Hello" }));
    expect(attempts).toBe(2);
    expect(texts).toEqual(["ok"]);
    await llm.destroy();
  });

  it("retries a pre-commit per-attempt timeout", async () => {
    let attempts = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 1),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    let timeoutTriggered = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });
    llm.onCore("TimeoutTriggered", () => {
      timeoutTriggered += 1;
    });

    const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
    const first = iterator.next();
    clock.tick(40);

    const event = await first;
    expect(event.done).toBe(false);
    expect(event.value).toMatchObject({ type: "text-delta", text: "A2" });
    expect(attempts).toBe(2);
    expect(retryStarted).toBe(1);
    expect(timeoutTriggered).toBe(1);

    await iterator.return?.();
    await llm.destroy();
  });

  it("does not retry a post-commit provider 429", async () => {
    await expectPostCommitNoRetry(new LlmError("rate_limited"));
  });

  it("does not retry a post-commit overloaded error", async () => {
    await expectPostCommitNoRetry(new LlmError("overloaded"));
  });

  it("does not retry a post-commit unknown provider error", async () => {
    await expectPostCommitNoRetry(new Error("socket explode"));
  });

  it("does not retry a post-commit per-attempt timeout or emit another generation", async () => {
    let attempts = 0;
    const clock = new FakeClock();
    const failed: LlmEvent[] = [];
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 0),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });
    llm.on("LlmStreamFailed", (event) => failed.push(event));

    let retryStarted = 0;
    let timeoutTriggered = 0;
    let streamStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });
    llm.onCore("TimeoutTriggered", () => {
      timeoutTriggered += 1;
    });
    llm.on("LlmStreamStarted", () => {
      streamStarted += 1;
    });

    const stream = llm.stream({ input: PROMPT });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "text-delta", text: "A1" });

    const pending = iterator.next();
    clock.tick(40);

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(isLlmError(error)).toBe(true);
    expect(error).toMatchObject({
      classification: "timeout",
      retryable: false,
    });
    expect(String(error)).not.toContain(PROMPT);
    expect(attempts).toBe(1);
    expect(retryStarted).toBe(0);
    expect(timeoutTriggered).toBe(1);
    expect(streamStarted).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: "LlmStreamFailed",
      committed: true,
      classification: "timeout",
      retryable: false,
    });
    expect(JSON.stringify(failed)).not.toContain(PROMPT);

    await expect(stream.result()).rejects.toMatchObject({
      classification: "timeout",
      retryable: false,
    });
    await llm.destroy();
  });

  it("does not retry caller abort before commit", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 0),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const controller = new AbortController();
    const stream = llm.stream({ input: "Hello", signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1);
    expect(retryStarted).toBe(0);
    await llm.destroy();
  });

  it("does not retry caller abort after commit", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;
          return iterate(
            [{ text: "A1" }, { text: "A2" }, { finishReason: "stop", usage: successUsage() }],
            {},
          );
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const controller = new AbortController();
    const stream = llm.stream({ input: "Hello", signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "text-delta", text: "A1" });

    controller.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1);
    expect(retryStarted).toBe(0);
    await llm.destroy();
  });

  it("does not retry on early consumer break", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 0),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const stream = llm.stream({ input: "Hello" });
    for await (const event of stream) {
      if (event.type === "text-delta") {
        break;
      }
    }

    expect(attempts).toBe(1);
    expect(retryStarted).toBe(0);
    await expect(stream.result()).rejects.toBeInstanceOf(AbortError);
    await llm.destroy();
  });

  it("settles Budget Guard once for post-commit timeout with retries configured", async () => {
    const accountant = createMemoryBudgetAccountant();
    const clock = new FakeClock();
    let attempts = 0;
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 0),
      model: "model-a",
      pricing,
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
      budget: { maxAccumulatedCostUsd: 1, accountant },
    });

    const stream = llm.stream({
      input: "Hello",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 4,
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    clock.tick(40);
    await pending.catch(() => undefined);

    expect(attempts).toBe(1);
    expect(accountant.getReservedMicroUsd("example")).toBe(0);
    await llm.destroy();
  });

  it("keeps one Budget Guard reservation across a pre-commit timeout retry that succeeds", async () => {
    const accountant = createMemoryBudgetAccountant();
    const clock = new FakeClock();
    let attempts = 0;
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 1),
      model: "model-a",
      pricing,
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
      budget: { maxAccumulatedCostUsd: 1, accountant },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const stream = llm.stream({
      input: "Hello",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 4,
    });
    const pending = collect(stream);
    clock.tick(40);
    await pending;
    await llm.destroy();

    expect(attempts).toBe(2);
    expect(retryStarted).toBe(1);
  });

  it("retries a pre-commit provider 503 then succeeds", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;
          if (attempts === 1) {
            throw new LlmError("provider_unavailable");
          }
          return iterate([{ text: "ok" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    expect(await collectTexts(llm.stream({ input: "Hello" }))).toEqual(["ok"]);
    expect(attempts).toBe(2);
    await llm.destroy();
  });

  it("does not commit on empty text or metadata before a timeout retry", async () => {
    const boxes: LlmStreamCommitState[] = [];
    let attempts = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream(_request, ctx) {
          attempts += 1;
          const box = ctx.metadata.get(LLM_STREAM_COMMIT_STATE_KEY) as LlmStreamCommitState;
          boxes.push(box);
          if (attempts === 1) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { model: "model-a" };
                yield { text: "" };
                await new Promise(() => undefined);
              },
            };
          }
          return iterate(
            [{ text: "SUCCESS" }, { finishReason: "stop", usage: successUsage() }],
            {},
          );
        },
      }),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const started: LlmEvent[] = [];
    const completed: LlmEvent[] = [];
    const failed: LlmEvent[] = [];
    llm.on("LlmStreamStarted", (event) => started.push(event));
    llm.on("LlmStreamCompleted", (event) => completed.push(event));
    llm.on("LlmStreamFailed", (event) => failed.push(event));

    const pending = collectTexts(llm.stream({ input: "Hello" }));
    clock.tick(40);
    expect(await pending).toEqual(["SUCCESS"]);
    expect(attempts).toBe(2);
    expect(retryStarted).toBe(1);
    expect(boxes[0]).toBe(boxes[1]);
    expect(boxes[0]?.committed).toBe(true);
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    await llm.destroy();
  });

  it("retries once on pre-commit timeout then does not retry after post-commit timeout", async () => {
    let attempts = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 1),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
    const first = iterator.next();
    clock.tick(40);
    expect((await first).value).toMatchObject({ type: "text-delta", text: "A2" });

    const pending = iterator.next();
    clock.tick(40);
    await expect(pending).rejects.toMatchObject({ classification: "timeout", retryable: false });
    expect(attempts).toBe(2);
    expect(retryStarted).toBe(1);
    await llm.destroy();
  });

  it("preserves RetryExceededError for pre-commit timeout exhaustion", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 99),
      model: "model-a",
      timeout: { perAttemptMs: 20 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const error = await llm
      .stream({ input: "Hello" })
      [Symbol.asyncIterator]()
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(RetryExceededError);
    expect((error as RetryExceededError).lastError).toBeInstanceOf(TimeoutError);
    expect(isLlmError(error)).toBe(false);
    expect(attempts).toBe(3);
    await llm.destroy();
  }, 10_000);

  it("overrides a custom always-retry classifier after commit", async () => {
    const custom: FailureClassifier = {
      isFailure: () => true,
      isRetryable: () => true,
    };
    let attempts = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: hangingAttemptProvider(() => {
        attempts += 1;
        return attempts;
      }, 0),
      model: "model-a",
      classifier: custom,
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    let retryStarted = 0;
    llm.onCore("RetryStarted", () => {
      retryStarted += 1;
    });

    const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    clock.tick(40);
    await expect(pending).rejects.toMatchObject({ classification: "timeout", retryable: false });
    expect(attempts).toBe(1);
    expect(retryStarted).toBe(0);
    expect(
      custom.isRetryable({ status: "error", error: new Error("x"), durationMs: 0 }, {} as never),
    ).toBe(true);
    await llm.destroy();
  });

  it("isolates commit boxes across concurrent streams on one client", async () => {
    const clock = new FakeClock();
    let streamAAttempts = 0;
    let streamBAttempts = 0;
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream(request) {
          if (request.input === "A") {
            streamAAttempts += 1;
            const attempt = streamAAttempts;
            return {
              [Symbol.asyncIterator]() {
                let index = 0;
                return {
                  next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                    index += 1;
                    if (index === 1) {
                      return Promise.resolve({
                        done: false,
                        value: { text: `A${String(attempt)}` },
                      });
                    }
                    return new Promise(() => undefined);
                  },
                  async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
          }
          streamBAttempts += 1;
          if (streamBAttempts === 1) {
            throw new LlmError("rate_limited");
          }
          return iterate([{ text: "B2" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const streamA = llm.stream({ input: "A" });
    const streamB = llm.stream({ input: "B" });
    const iteratorA = streamA[Symbol.asyncIterator]();
    expect((await iteratorA.next()).value).toMatchObject({ text: "A1" });

    const textsB = collectTexts(streamB);
    const pendingA = iteratorA.next();
    clock.tick(40);

    expect(await textsB).toEqual(["B2"]);
    await expect(pendingA).rejects.toMatchObject({ classification: "timeout" });
    expect(streamAAttempts).toBe(1);
    expect(streamBAttempts).toBe(2);
    await llm.destroy();
  });

  it("settles Budget Guard once for pre-commit timeout retry success", async () => {
    const inner = createMemoryBudgetAccountant();
    let reserveCalls = 0;
    const accountant = {
      getAccumulatedMicroUsd: inner.getAccumulatedMicroUsd.bind(inner),
      getReservedMicroUsd: inner.getReservedMicroUsd.bind(inner),
      reserve(scope: string, estimatedMicroUsd: number, maxAccumulatedMicroUsd?: number): boolean {
        reserveCalls += 1;
        return inner.reserve(scope, estimatedMicroUsd, maxAccumulatedMicroUsd);
      },
      settle: inner.settle.bind(inner),
    };
    let attempts = 0;
    const clock = new FakeClock();
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          throw new Error("unused");
        },
        async stream() {
          attempts += 1;
          if (attempts === 1) {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                    return new Promise(() => undefined);
                  },
                  async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                    return { done: true, value: undefined };
                  },
                };
              },
            };
          }
          return iterate([{ text: "ok" }, { finishReason: "stop", usage: successUsage() }], {});
        },
      }),
      model: "model-a",
      pricing,
      clock,
      timeout: { perAttemptMs: 40 },
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
      budget: { maxAccumulatedCostUsd: 1, accountant },
    });

    const pending = collect(
      llm.stream({ input: "Hello", estimatedInputTokens: 10, estimatedOutputTokens: 4 }),
    );
    clock.tick(40);
    const events = await pending;

    expect(attempts).toBe(2);
    expect(reserveCalls).toBe(1);
    expect(events.some((event) => event.type === "completed")).toBe(true);
    await llm.destroy();
  });
});

function abortNow(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function collectTexts(stream: AsyncIterable<LlmStreamEvent>): Promise<string[]> {
  const texts: string[] = [];

  for await (const event of stream) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }

  return texts;
}

async function expectPostCommitNoRetry(failure: Error): Promise<void> {
  let attempts = 0;
  const llm = createLlmClient({
    provider: defineProvider({
      name: "example",
      async execute() {
        throw new Error("unused");
      },
      async stream() {
        attempts += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { text: `A${String(attempts)}` };
            throw failure;
          },
        };
      },
    }),
    model: "model-a",
    retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
  });

  let retryStarted = 0;
  llm.onCore("RetryStarted", () => {
    retryStarted += 1;
  });

  const texts: string[] = [];
  await expect(
    (async () => {
      for await (const event of llm.stream({ input: "Hello" })) {
        if (event.type === "text-delta") {
          texts.push(event.text);
        }
      }
    })(),
  ).rejects.toBeInstanceOf(Error);

  expect(attempts).toBe(1);
  expect(texts).toEqual(["A1"]);
  expect(retryStarted).toBe(0);
  await llm.destroy();
}

function hangingAttemptProvider(nextAttempt: () => number, hangBeforeTextAttempts: number) {
  return defineProvider({
    name: "example",
    async execute() {
      throw new Error("unused");
    },
    async stream() {
      const attempt = nextAttempt();

      if (attempt <= hangBeforeTextAttempts) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                return new Promise(() => undefined);
              },
              async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
                return { done: true, value: undefined };
              },
            };
          },
        };
      }

      return {
        [Symbol.asyncIterator]() {
          let index = 0;

          return {
            next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
              index += 1;

              if (index === 1) {
                return Promise.resolve({
                  done: false,
                  value: { text: `A${String(attempt)}` },
                });
              }

              if (hangBeforeTextAttempts === 0) {
                return new Promise(() => undefined);
              }

              if (index === 2) {
                return Promise.resolve({
                  done: false,
                  value: { finishReason: "stop", usage: successUsage() },
                });
              }

              return Promise.resolve({ done: true, value: undefined });
            },
            async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });
}

function createRecordingMetrics(): MetricsRecorder & {
  counterValue(name: string, labels?: Labels): number;
  labelKeys(): string[];
} {
  const counters = new Map<string, number>();
  const keys = new Set<string>();
  const labelKey = (labels?: Labels): string => {
    if (labels === undefined) {
      return "";
    }

    for (const key of Object.keys(labels)) {
      keys.add(key);
    }

    return Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
  };

  return {
    counter(name: string) {
      return {
        add(value: number, labels?: Labels): void {
          const key = `${name}|${labelKey(labels)}`;
          counters.set(key, (counters.get(key) ?? 0) + value);
        },
      };
    },
    gauge() {
      return {
        set(): void {
          // unused
        },
      };
    },
    histogram() {
      return {
        record(): void {
          // unused
        },
      };
    },
    counterValue(name: string, labels?: Labels): number {
      return counters.get(`${name}|${labelKey(labels)}`) ?? 0;
    },
    labelKeys(): string[] {
      return [...keys].sort((left, right) => left.localeCompare(right));
    },
  };
}

class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  get activeTimers(): number {
    return this.#timers.size;
  }

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
