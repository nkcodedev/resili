import { AbortError, ConfigurationError, type Labels, type MetricsRecorder } from "@resili/core";
import { describe, expect, it, vi } from "vitest";

import {
  createLlmClient,
  createPricingResolver,
  defineProvider,
  isLlmErrorRetryable,
  LLM_METRIC_NAMES,
  LlmBudgetExceededError,
  LlmError,
  type LlmEvent,
  type LlmResponse,
} from "./index";

const PROMPT = "SECRET_PROMPT_DO_NOT_EMIT";
const OUTPUT = "SECRET_RESPONSE_DO_NOT_EMIT";

function exampleProvider(
  execute: (request: { readonly input: string }) => Promise<LlmResponse> | LlmResponse,
) {
  return defineProvider({
    name: "example",
    async execute(request, ctx) {
      void ctx;

      const response = await execute(request);

      return {
        ...response,
        provider: response.provider,
        model: response.model,
      };
    },
  });
}

function successResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    provider: "example",
    model: "model-a",
    content: OUTPUT,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    finishReason: "stop",
    ...overrides,
  };
}

const pricing = createPricingResolver([
  {
    provider: "example",
    model: "model-a",
    inputPerMillionTokensUsd: 1,
    outputPerMillionTokensUsd: 5,
  },
]);

describe("createLlmClient", () => {
  it("returns a normalized response from the provider", async () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
    });

    const result = await llm.generate({ input: "Hello" });

    expect(result.response.content).toBe(OUTPUT);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(result.cost?.totalCostMicroUsd).toBe(350);
    await llm.destroy();
  });

  it("propagates provider failures without wrapping the thrown value", async () => {
    const failure = new LlmError("rate_limited", { cause: new Error("429") });
    const llm = createLlmClient({
      provider: exampleProvider(() => Promise.reject(failure)),
      model: "model-a",
    });

    await expect(llm.generate({ input: "Hello" })).rejects.toBe(failure);
    expect(isLlmErrorRetryable(failure)).toBe(true);
    await llm.destroy();
  });

  it("allows a request below and exactly at the per-request budget", async () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
      budget: { maxCostPerRequestUsd: 0.00035 },
    });

    await expect(
      llm.generate({
        input: "Hello",
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      }),
    ).resolves.toMatchObject({ cost: { totalCostMicroUsd: 350 } });
    await llm.destroy();
  });

  it("rejects a request above the per-request budget with a typed error and event", async () => {
    const events: LlmEvent[] = [];
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
      budget: { maxCostPerRequestUsd: 0.0002 },
    });
    llm.on("LlmBudgetRejected", (event) => {
      events.push(event);
    });

    await expect(
      llm.generate({
        input: PROMPT,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "LlmBudgetRejected",
      limitKind: "per-request",
      provider: "example",
      model: "model-a",
    });
    await llm.destroy();
  });

  it("tracks accumulated budget across requests", async () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
      budget: { maxAccumulatedCostUsd: 0.00035 },
    });

    await llm.generate({ input: "one" });
    await expect(llm.generate({ input: "two" })).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await llm.destroy();
  });

  it("emits lifecycle and usage events without prompt or response bodies", async () => {
    const events: LlmEvent[] = [];
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
    });
    llm.on("LlmRequestStarted", (event) => events.push(event));
    llm.on("LlmRequestCompleted", (event) => events.push(event));
    llm.on("LlmUsageRecorded", (event) => events.push(event));

    await llm.generate({ input: PROMPT });

    expect(events.map((event) => event.type)).toEqual([
      "LlmRequestStarted",
      "LlmUsageRecorded",
      "LlmRequestCompleted",
    ]);
    expect(JSON.stringify(events)).not.toContain(PROMPT);
    expect(JSON.stringify(events)).not.toContain(OUTPUT);
    expect(JSON.stringify(events)).not.toContain("sk-");
    await llm.destroy();
  });

  it("emits a failed event without wrapping unknown errors as the thrown value", async () => {
    const events: LlmEvent[] = [];
    const failure = new Error("boom");
    const llm = createLlmClient({
      provider: exampleProvider(() => Promise.reject(failure)),
      model: "model-a",
    });
    llm.on("LlmRequestFailed", (event) => events.push(event));

    await expect(llm.generate({ input: PROMPT })).rejects.toBe(failure);
    expect(events).toEqual([
      expect.objectContaining({
        type: "LlmRequestFailed",
        classification: "unknown",
        retryable: false,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(PROMPT);
    await llm.destroy();
  });

  it("records low-cardinality success metrics", async () => {
    const metrics = createRecordingMetrics();
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
      metrics,
    });

    await llm.generate({ input: PROMPT });

    expect(metrics.counterValue(LLM_METRIC_NAMES.requests, { result: "success" })).toBe(1);
    expect(metrics.counterValue(LLM_METRIC_NAMES.inputTokens, { result: "success" })).toBe(100);
    expect(metrics.counterValue(LLM_METRIC_NAMES.outputTokens, { result: "success" })).toBe(50);
    expect(metrics.counterValue(LLM_METRIC_NAMES.tokens, { result: "success" })).toBe(150);
    expect(metrics.counterValue(LLM_METRIC_NAMES.costMicroUsd, { result: "success" })).toBe(350);
    expect(metrics.histogramValues(LLM_METRIC_NAMES.latencyMs, { result: "success" }).length).toBe(
      1,
    );
    expect(metrics.labelKeys()).toEqual(["result"]);
    await llm.destroy();
  });

  it("records failure and budget rejection metrics", async () => {
    const failureMetrics = createRecordingMetrics();
    const failing = createLlmClient({
      provider: exampleProvider(() => Promise.reject(new LlmError("overloaded"))),
      model: "model-a",
      metrics: failureMetrics,
    });

    await expect(failing.generate({ input: "x" })).rejects.toBeInstanceOf(LlmError);
    expect(failureMetrics.counterValue(LLM_METRIC_NAMES.failures, { result: "failure" })).toBe(1);

    const budgetMetrics = createRecordingMetrics();
    const guarded = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      pricing,
      metrics: budgetMetrics,
      budget: { maxCostPerRequestUsd: 0.000001 },
    });

    await expect(
      guarded.generate({
        input: "x",
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
      }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(
      budgetMetrics.counterValue(LLM_METRIC_NAMES.budgetRejections, { result: "budget_rejected" }),
    ).toBe(1);

    await failing.destroy();
    await guarded.destroy();
  });

  it("retries retryable LLM errors through core retry policy", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: exampleProvider(() => {
        attempts += 1;

        if (attempts === 1) {
          return Promise.reject(new LlmError("overloaded"));
        }

        return successResponse();
      }),
      model: "model-a",
      retry: { maxAttempts: 2, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    await expect(llm.generate({ input: "Hello" })).resolves.toMatchObject({
      usage: { totalTokens: 150 },
    });
    expect(attempts).toBe(2);
    await llm.destroy();
  });

  it("passes the context abort signal to the provider", async () => {
    const seen = vi.fn();
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        execute(_request, ctx) {
          seen(ctx.signal);

          return Promise.resolve(successResponse());
        },
      }),
      model: "model-a",
    });

    await llm.generate({ input: "Hello" });
    expect(seen.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await llm.destroy();
  });

  it("rejects generate() when the caller signal is already aborted", async () => {
    let attempts = 0;
    const llm = createLlmClient({
      provider: exampleProvider(() => {
        attempts += 1;
        return successResponse();
      }),
      model: "model-a",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(llm.generate({ input: "Hello", signal: controller.signal })).rejects.toSatisfy(
      isCancellation,
    );
    expect(attempts).toBe(0);
    await llm.destroy();
  });

  it("does not retry generate() after an in-flight caller abort", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute(_request, ctx) {
          attempts += 1;
          await new Promise<void>((resolve, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new AbortError());
              },
              { once: true },
            );
          });
          return successResponse();
        },
      }),
      model: "model-a",
      retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    const pending = llm.generate({ input: "Hello", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy(isCancellation);
    expect(attempts).toBe(1);
    await llm.destroy();
  });

  it("records LLM metrics without forwarding the recorder into Core policies", async () => {
    const names: string[] = [];
    const metrics: MetricsRecorder = {
      counter(name) {
        names.push(name);
        return {
          add() {
            // capture name only
          },
        };
      },
      histogram(name) {
        names.push(name);
        return {
          record() {
            // capture name only
          },
        };
      },
      gauge(name) {
        names.push(name);
        return {
          set() {
            // capture name only
          },
        };
      },
    };
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
      metrics,
      timeout: { perAttemptMs: 5_000 },
    });

    await llm.generate({ input: "Hello" });
    expect(names.some((name) => name.startsWith("resili_llm_"))).toBe(true);
    expect(names.some((name) => name.startsWith("resili_timeout") || name.includes("retry"))).toBe(
      false,
    );
    await llm.destroy();
  });

  it("rejects stream() when the provider has no stream implementation", () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
    });

    expect(() => llm.stream({ input: "Hello" })).toThrow(ConfigurationError);
  });

  it("does not expose Core execute/stats/health on the LLM client", () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse()),
      model: "model-a",
    });

    expect(llm).not.toHaveProperty("execute");
    expect(llm).not.toHaveProperty("stats");
    expect(llm).not.toHaveProperty("health");
    expect(llm).not.toHaveProperty("call");
  });

  it("rejects unknown pricing by default instead of treating it as $0", async () => {
    const events: LlmEvent[] = [];
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse({ model: "unpriced" })),
      model: "unpriced",
      pricing,
      budget: { maxCostPerRequestUsd: 1 },
    });
    llm.on("LlmBudgetRejected", (event) => events.push(event));

    await expect(
      llm.generate({
        input: PROMPT,
        estimatedInputTokens: 1_000_000,
        estimatedOutputTokens: 1_000_000,
      }),
    ).rejects.toMatchObject({ limitKind: "unknown-pricing" });
    expect(events[0]).toMatchObject({ type: "LlmBudgetRejected", limitKind: "unknown-pricing" });
    await llm.destroy();
  });

  it("allows unknown pricing only when onUnknownPricing is allow", async () => {
    const llm = createLlmClient({
      provider: exampleProvider(() => successResponse({ model: "unpriced" })),
      model: "unpriced",
      pricing,
      budget: { maxCostPerRequestUsd: 0.000001, onUnknownPricing: "allow" },
    });

    const result = await llm.generate({
      input: "Hello",
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
    });

    expect(result.cost).toBeUndefined();
    expect(result.response.content).toBe(OUTPUT);
    await llm.destroy();
  });

  it("requires pricing when Budget Guard uses the default reject behavior", () => {
    expect(() =>
      createLlmClient({
        provider: exampleProvider(() => successResponse()),
        model: "model-a",
        budget: { maxCostPerRequestUsd: 1 },
      }),
    ).toThrow(ConfigurationError);
  });

  it("does not treat maxCostPerRequestUsd as a hard ceiling on actual usage", async () => {
    const llm = createLlmClient({
      provider: exampleProvider(() =>
        successResponse({
          usage: { inputTokens: 100, outputTokens: 5_000, totalTokens: 5_100 },
        }),
      ),
      model: "model-a",
      pricing,
      budget: { maxCostPerRequestUsd: 0.00035 },
    });

    const result = await llm.generate({
      input: "Hello",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
    });

    expect(result.cost?.totalCostMicroUsd).toBeGreaterThan(350);
    await llm.destroy();
  });

  it("admits only one of two concurrent requests that would together exceed the cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;

    const llm = createLlmClient({
      provider: defineProvider({
        name: "example",
        async execute() {
          inFlight += 1;
          await gate;

          return successResponse();
        },
      }),
      model: "model-a",
      pricing,
      budget: { maxAccumulatedCostUsd: 0.00035 },
    });

    const first = llm.generate({
      input: "a",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
    });
    const second = llm.generate({
      input: "b",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBe(1);

    release();

    const outcomes = await Promise.allSettled([first, second]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedOutcome = rejected[0];
    expect(rejectedOutcome?.status).toBe("rejected");
    if (rejectedOutcome?.status === "rejected") {
      expect(rejectedOutcome.reason).toBeInstanceOf(LlmBudgetExceededError);
    }
    await llm.destroy();
  });
});

function createRecordingMetrics(): MetricsRecorder & {
  counterValue(name: string, labels?: Labels): number;
  histogramValues(name: string, labels?: Labels): readonly number[];
  labelKeys(): string[];
} {
  const counters = new Map<string, number>();
  const histograms = new Map<string, number[]>();
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
    histogram(name: string) {
      return {
        record(value: number, labels?: Labels): void {
          const key = `${name}|${labelKey(labels)}`;
          const values = histograms.get(key) ?? [];
          values.push(value);
          histograms.set(key, values);
        },
      };
    },
    counterValue(name: string, labels?: Labels): number {
      return counters.get(`${name}|${labelKey(labels)}`) ?? 0;
    },
    histogramValues(name: string, labels?: Labels): readonly number[] {
      return histograms.get(`${name}|${labelKey(labels)}`) ?? [];
    },
    labelKeys(): string[] {
      return [...keys].sort((left, right) => left.localeCompare(right));
    },
  };
}

function isCancellation(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}
