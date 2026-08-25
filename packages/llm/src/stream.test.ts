/* eslint-disable @typescript-eslint/require-await */
import {
  AbortError,
  ConfigurationError,
  type Clock,
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
  type LlmEvent,
  type LlmProviderStreamFrame,
  type LlmResponse,
  type LlmStreamEvent,
} from "./index";

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
});

function abortNow(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
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
