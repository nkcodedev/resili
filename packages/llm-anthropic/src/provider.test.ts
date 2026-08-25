import { ConfigurationError, TimeoutError } from "@resili/core";
import {
  createLlmClient,
  createPricingResolver,
  isLlmErrorRetryable,
  LlmBudgetExceededError,
  LlmError,
  type LlmEvent,
} from "@resili/llm";
import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_SDK_MAX_RETRIES,
  createAnthropicProvider,
  type AnthropicClient,
  type AnthropicMessage,
  type AnthropicRequestOptions,
  type AnthropicStreamEvent,
} from "./index";

const PROMPT = "SECRET_PROMPT_DO_NOT_LEAK";
const OUTPUT = "SECRET_COMPLETION_DO_NOT_LEAK";
const API_KEY = "sk-ant-secret-test-key";
const MODEL = "claude-sonnet-4-5";

function message(overrides: Partial<AnthropicMessage> = {}): AnthropicMessage {
  return {
    model: MODEL,
    content: [{ type: "text", text: OUTPUT }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
    },
    ...overrides,
  };
}

function mockClient(
  create: (
    body: {
      readonly model: string;
      readonly max_tokens: number;
      readonly messages: readonly unknown[];
      readonly stream?: boolean;
    },
    options?: AnthropicRequestOptions,
  ) => Promise<AnthropicMessage | AsyncIterable<AnthropicStreamEvent>>,
): AnthropicClient {
  return {
    messages: {
      create,
    },
  };
}

function ctx(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

describe("createAnthropicProvider", () => {
  it("normalizes a successful Messages response", async () => {
    const create = vi.fn(() => Promise.resolve(message()));
    const provider = createAnthropicProvider({
      client: mockClient(create),
      model: MODEL,
      maxTokens: 128,
    });

    const result = await provider.execute(
      { provider: "anthropic", model: MODEL, input: PROMPT },
      ctx() as never,
    );

    expect(result).toEqual({
      provider: "anthropic",
      model: MODEL,
      content: OUTPUT,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      finishReason: "stop",
    });
    expect(create.mock.calls[0]?.[0]).toEqual({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(create.mock.calls[0]?.[1]?.maxRetries).toBe(0);
    expect(create.mock.calls[0]?.[1]?.maxRetries).toBe(ANTHROPIC_SDK_MAX_RETRIES);
  });

  it("uses the configured model when the request model is empty", async () => {
    const create = vi.fn(() => Promise.resolve(message()));
    const provider = createAnthropicProvider({
      client: mockClient(create),
      model: MODEL,
      maxTokens: 64,
    });

    await provider.execute({ provider: "anthropic", model: "  ", input: "x" }, ctx() as never);

    expect(create.mock.calls[0]?.[0]?.model).toBe(MODEL);
  });

  it("uses the response model identity when present", async () => {
    const provider = createAnthropicProvider({
      client: mockClient(() => Promise.resolve(message({ model: "claude-sonnet-4-5-20250929" }))),
      model: MODEL,
      maxTokens: 64,
    });

    await expect(
      provider.execute({ provider: "anthropic", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ model: "claude-sonnet-4-5-20250929" });
  });

  it("concatenates multiple text blocks and ignores unsupported blocks", async () => {
    const provider = createAnthropicProvider({
      client: mockClient(() =>
        Promise.resolve(
          message({
            content: [
              { type: "text", text: "Hello" },
              { type: "tool_use", text: "ignored" },
              { type: "text", text: "World" },
            ],
          }),
        ),
      ),
      model: MODEL,
      maxTokens: 64,
    });

    await expect(
      provider.execute({ provider: "anthropic", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ content: "HelloWorld" });
  });

  it("maps missing usage to zero counts without inventing tokens", async () => {
    const provider = createAnthropicProvider({
      client: mockClient(() => Promise.resolve(message({ usage: undefined }))),
      model: MODEL,
      maxTokens: 64,
    });

    await expect(
      provider.execute({ provider: "anthropic", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it("puts cache and thinking counts on usage.dimensions", async () => {
    const provider = createAnthropicProvider({
      client: mockClient(() =>
        Promise.resolve(
          message({
            usage: {
              input_tokens: 8,
              output_tokens: 2,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 5,
              output_tokens_details: { thinking_tokens: 1 },
            },
          }),
        ),
      ),
      model: MODEL,
      maxTokens: 64,
    });

    await expect(
      provider.execute({ provider: "anthropic", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        dimensions: {
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 5,
          thinkingTokens: 1,
        },
      },
    });
  });

  it("maps Anthropic stop reasons", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["max_tokens", "length"],
      ["model_context_window_exceeded", "length"],
      ["tool_use", "tool_calls"],
      ["refusal", "content_filter"],
      ["pause_turn", "unknown"],
      ["brand_new_reason", "unknown"],
    ];

    for (const [stopReason, finishReason] of cases) {
      const provider = createAnthropicProvider({
        client: mockClient(() => Promise.resolve(message({ stop_reason: stopReason }))),
        model: MODEL,
        maxTokens: 64,
      });

      await expect(
        provider.execute({ provider: "anthropic", model: MODEL, input: "x" }, ctx() as never),
      ).resolves.toMatchObject({ finishReason });
    }
  });

  it("does not attach the raw SDK message to the normalized response", async () => {
    const raw = message();
    const provider = createAnthropicProvider({
      client: mockClient(() => Promise.resolve(raw)),
      model: MODEL,
      maxTokens: 64,
    });

    const result = await provider.execute(
      { provider: "anthropic", model: MODEL, input: "x" },
      ctx() as never,
    );

    expect(result).not.toHaveProperty("raw");
    expect(JSON.stringify(result)).not.toContain("stop_reason");
  });

  it("requires a positive integer maxTokens", () => {
    expect(() =>
      createAnthropicProvider({
        client: mockClient(() => Promise.resolve(message())),
        model: MODEL,
        maxTokens: 0,
      }),
    ).toThrow(ConfigurationError);
  });
});

describe("Anthropic error normalization", () => {
  async function executeFailing(error: unknown): Promise<unknown> {
    const provider = createAnthropicProvider({
      client: mockClient(() => Promise.reject(error instanceof Error ? error : new Error("test"))),
      model: MODEL,
      maxTokens: 64,
    });

    try {
      await provider.execute(
        { provider: "anthropic", model: MODEL, input: PROMPT },
        ctx() as never,
      );
      return undefined;
    } catch (caught) {
      return caught;
    }
  }

  it("maps authentication errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("401"), { name: "AuthenticationError", status: 401 }),
    );

    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ classification: "authentication", retryable: false });
    expect(isLlmErrorRetryable(mapped)).toBe(false);
    expect(JSON.stringify(mapped)).not.toContain(PROMPT);
    expect(JSON.stringify(mapped)).not.toContain(API_KEY);
  });

  it("maps authorization errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("403"), { name: "PermissionDeniedError", status: 403 }),
    );

    expect(mapped).toMatchObject({ classification: "authorization", retryable: false });
  });

  it("maps rate limit errors as retryable", async () => {
    const headers = { get: (name: string) => (name === "retry-after" ? "2" : null) };
    const mapped = await executeFailing(
      Object.assign(new Error("429"), { name: "RateLimitError", status: 429, headers }),
    );

    expect(mapped).toMatchObject({
      classification: "rate_limited",
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it("maps connection timeouts", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }),
    );

    expect(mapped).toMatchObject({ classification: "timeout", retryable: true });
  });

  it("maps network errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("reset"), { name: "APIConnectionError", code: "ECONNRESET" }),
    );

    expect(mapped).toMatchObject({ classification: "network_transient", retryable: true });
  });

  it("maps overloaded and server errors", async () => {
    await expect(
      executeFailing(
        Object.assign(new Error("529"), { status: 529, error: { type: "overloaded_error" } }),
      ),
    ).resolves.toMatchObject({ classification: "overloaded", retryable: true });

    await expect(
      executeFailing(Object.assign(new Error("500"), { name: "InternalServerError", status: 500 })),
    ).resolves.toMatchObject({ classification: "provider_unavailable", retryable: true });
  });

  it("maps unknown errors without leaking prompts or keys", async () => {
    const mapped = await executeFailing(new Error(`failed for ${PROMPT} with ${API_KEY}`));

    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ classification: "unknown", retryable: false });
    expect(JSON.stringify(mapped)).not.toContain(PROMPT);
    expect(JSON.stringify(mapped)).not.toContain(API_KEY);
    expect((mapped as LlmError).message).not.toContain(PROMPT);
  });
});

describe("createLlmClient + Anthropic provider", () => {
  const pricing = createPricingResolver([
    {
      provider: "anthropic",
      model: MODEL,
      inputPerMillionTokensUsd: 3,
      outputPerMillionTokensUsd: 15,
    },
  ]);

  it("records usage and example cost through the LLM client", async () => {
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(() => Promise.resolve(message())),
        model: MODEL,
        maxTokens: 64,
      }),
      model: MODEL,
      pricing,
    });

    const result = await llm.generate({ input: "Hello" });

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(result.cost?.totalCostMicroUsd).toBe(30 + 60);
    expect(result.response.provider).toBe("anthropic");
    await llm.destroy();
  });

  it("rejects through Budget Guard before calling Anthropic", async () => {
    let called = 0;
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(() => {
          called += 1;
          return Promise.resolve(message());
        }),
        model: MODEL,
        maxTokens: 64,
      }),
      model: MODEL,
      pricing,
      budget: { maxCostPerRequestUsd: 0.000_001 },
    });

    await expect(
      llm.generate({
        input: "Hello",
        estimatedInputTokens: 100_000,
        estimatedOutputTokens: 100_000,
      }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(called).toBe(0);
    await llm.destroy();
  });

  it("propagates AbortSignal and Resili timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient((_body, options) => {
          seenSignal = options?.signal ?? undefined;

          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }));
            });
          });
        }),
        model: MODEL,
        maxTokens: 64,
      }),
      model: MODEL,
      timeout: { perAttemptMs: 20 },
    });

    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(TimeoutError);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    await llm.destroy();
  });

  it("retries retryable Anthropic errors through Resili, not the SDK", async () => {
    let attempts = 0;
    const create = vi.fn((_body, options?: AnthropicRequestOptions) => {
      attempts += 1;
      expect(options?.maxRetries).toBe(0);

      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("429"), { name: "RateLimitError", status: 429 }),
        );
      }

      return Promise.resolve(message());
    });
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(create),
        model: MODEL,
        maxTokens: 64,
      }),
      model: MODEL,
      retry: { maxAttempts: 2, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
    });

    await expect(llm.generate({ input: "Hello" })).resolves.toMatchObject({
      usage: { totalTokens: 14 },
    });
    expect(attempts).toBe(2);
    await llm.destroy();
  });

  it("does not emit prompts or secrets on LLM events", async () => {
    const events: LlmEvent[] = [];
    const llm = createLlmClient({
      provider: createAnthropicProvider({
        client: mockClient(() => Promise.resolve(message())),
        model: MODEL,
        maxTokens: 64,
      }),
      model: MODEL,
    });
    llm.on("LlmRequestStarted", (event) => events.push(event));
    llm.on("LlmRequestCompleted", (event) => events.push(event));
    llm.on("LlmUsageRecorded", (event) => events.push(event));

    await llm.generate({ input: PROMPT });

    expect(JSON.stringify(events)).not.toContain(PROMPT);
    expect(JSON.stringify(events)).not.toContain(OUTPUT);
    expect(JSON.stringify(events)).not.toContain("sk-ant-");
    await llm.destroy();
  });
});
