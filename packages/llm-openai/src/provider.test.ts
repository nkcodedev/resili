import { TimeoutError } from "@resili/core";
import {
  createLlmClient,
  createPricingResolver,
  isLlmErrorRetryable,
  LlmError,
  type LlmEvent,
} from "@resili/llm";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenAiProvider,
  OPENAI_SDK_MAX_RETRIES,
  type OpenAiChatCompletion,
  type OpenAiChatCompletionChunk,
  type OpenAiClient,
  type OpenAiRequestOptions,
} from "./index";

const PROMPT = "SECRET_PROMPT_DO_NOT_LEAK";
const OUTPUT = "SECRET_COMPLETION_DO_NOT_LEAK";
const API_KEY = "sk-secret-test-key";

function completion(overrides: Partial<OpenAiChatCompletion> = {}): OpenAiChatCompletion {
  return {
    model: "gpt-4.1-mini",
    choices: [
      {
        finish_reason: "stop",
        message: { content: OUTPUT },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    },
    ...overrides,
  };
}

function mockClient(
  create: (
    body: {
      readonly model: string;
      readonly messages: readonly unknown[];
      readonly stream?: boolean;
    },
    options?: OpenAiRequestOptions,
  ) => Promise<OpenAiChatCompletion | AsyncIterable<OpenAiChatCompletionChunk>>,
): OpenAiClient {
  return {
    chat: {
      completions: {
        create,
      },
    },
  };
}

describe("createOpenAiProvider", () => {
  it("normalizes a successful Chat Completions response", async () => {
    const create = vi.fn(() => Promise.resolve(completion()));
    const provider = createOpenAiProvider({
      client: mockClient(create),
      model: "gpt-4.1-mini",
    });

    const result = await provider.execute(
      { provider: "openai", model: "gpt-4.1-mini", input: PROMPT },
      { signal: new AbortController().signal } as never,
    );

    expect(result).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      content: OUTPUT,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      finishReason: "stop",
    });
    expect(create.mock.calls[0]?.[0]).toEqual({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: OPENAI_SDK_MAX_RETRIES,
    });
    expect(create.mock.calls[0]?.[1]?.maxRetries).toBe(0);
  });

  it("maps finish reasons", async () => {
    const provider = createOpenAiProvider({
      client: mockClient(() =>
        Promise.resolve(
          completion({ choices: [{ finish_reason: "length", message: { content: "x" } }] }),
        ),
      ),
      model: "gpt-4.1-mini",
    });

    await expect(
      provider.execute({ provider: "openai", model: "gpt-4.1-mini", input: "x" }, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({ finishReason: "length" });
  });

  it("maps missing usage to zero counts without inventing tokens", async () => {
    const provider = createOpenAiProvider({
      client: mockClient(() => Promise.resolve(completion({ usage: undefined }))),
      model: "gpt-4.1-mini",
    });

    await expect(
      provider.execute({ provider: "openai", model: "gpt-4.1-mini", input: "x" }, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it("maps zero token usage as zero", async () => {
    const provider = createOpenAiProvider({
      client: mockClient(() =>
        Promise.resolve(
          completion({
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        ),
      ),
      model: "gpt-4.1-mini",
    });

    await expect(
      provider.execute({ provider: "openai", model: "gpt-4.1-mini", input: "x" }, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it("uses the completion model identity when present", async () => {
    const provider = createOpenAiProvider({
      client: mockClient(() => Promise.resolve(completion({ model: "gpt-4.1-mini-2025-04-14" }))),
      model: "gpt-4.1-mini",
    });

    await expect(
      provider.execute({ provider: "openai", model: "gpt-4.1-mini", input: "x" }, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({ model: "gpt-4.1-mini-2025-04-14" });
  });
});

describe("OpenAI error normalization", () => {
  async function executeFailing(error: unknown): Promise<unknown> {
    const provider = createOpenAiProvider({
      client: mockClient(() => Promise.reject(error instanceof Error ? error : new Error("test"))),
      model: "gpt-4.1-mini",
    });

    try {
      await provider.execute({ provider: "openai", model: "gpt-4.1-mini", input: PROMPT }, {
        signal: new AbortController().signal,
      } as never);
      return undefined;
    } catch (caught) {
      return caught;
    }
  }

  it("maps authentication errors", async () => {
    const error = Object.assign(new Error("401"), { name: "AuthenticationError", status: 401 });
    const mapped = await executeFailing(error);

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
    const error = Object.assign(new Error("429"), {
      name: "RateLimitError",
      status: 429,
      headers,
    });
    const mapped = await executeFailing(error);

    expect(mapped).toMatchObject({
      classification: "rate_limited",
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it("maps connection timeouts", async () => {
    const error = Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" });
    const mapped = await executeFailing(error);

    expect(mapped).toMatchObject({ classification: "timeout", retryable: true });
  });

  it("maps server errors", async () => {
    const error = Object.assign(new Error("500"), { name: "InternalServerError", status: 500 });
    const mapped = await executeFailing(error);

    expect(mapped).toMatchObject({
      classification: "provider_unavailable",
      retryable: true,
    });
  });

  it("maps unknown errors without leaking prompts or keys", async () => {
    const error = new Error(`failed for ${PROMPT} with ${API_KEY}`);
    const mapped = await executeFailing(error);

    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ classification: "unknown", retryable: false });
    expect(JSON.stringify(mapped)).not.toContain(PROMPT);
    expect(JSON.stringify(mapped)).not.toContain(API_KEY);
    expect((mapped as LlmError).message).not.toContain(PROMPT);
  });

  it("maps context length and content policy codes", async () => {
    await expect(
      executeFailing(
        Object.assign(new Error("ctx"), { status: 400, code: "context_length_exceeded" }),
      ),
    ).resolves.toMatchObject({ classification: "context_limit_exceeded", retryable: false });

    await expect(
      executeFailing(Object.assign(new Error("policy"), { status: 400, code: "content_filter" })),
    ).resolves.toMatchObject({ classification: "content_policy", retryable: false });
  });
});

describe("createLlmClient + OpenAI provider", () => {
  const pricing = createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]);

  it("records usage and example cost through the LLM client", async () => {
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient(() => Promise.resolve(completion())),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
      pricing,
    });

    const result = await llm.generate({ input: "Hello" });

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(result.cost?.totalCostMicroUsd).toBe(10 + 20);
    await llm.destroy();
  });

  it("propagates AbortSignal and Resili timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const llm = createLlmClient({
      provider: createOpenAiProvider({
        client: mockClient((_body, options) => {
          seenSignal = options?.signal;

          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }));
            });
          });
        }),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
      timeout: { perAttemptMs: 20 },
    });

    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(TimeoutError);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    await llm.destroy();
  });

  it("retries retryable OpenAI errors through Resili, not the SDK", async () => {
    let attempts = 0;
    const create = vi.fn((_body, options?: OpenAiRequestOptions) => {
      attempts += 1;
      expect(options?.maxRetries).toBe(0);

      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("429"), { name: "RateLimitError", status: 429 }),
        );
      }

      return Promise.resolve(completion());
    });
    const llm = createLlmClient({
      provider: createOpenAiProvider({ client: mockClient(create), model: "gpt-4.1-mini" }),
      model: "gpt-4.1-mini",
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
      provider: createOpenAiProvider({
        client: mockClient(() => Promise.resolve(completion())),
        model: "gpt-4.1-mini",
      }),
      model: "gpt-4.1-mini",
    });
    llm.on("LlmRequestStarted", (event) => events.push(event));
    llm.on("LlmRequestCompleted", (event) => events.push(event));
    llm.on("LlmUsageRecorded", (event) => events.push(event));

    await llm.generate({ input: PROMPT });

    expect(JSON.stringify(events)).not.toContain(PROMPT);
    expect(JSON.stringify(events)).not.toContain(OUTPUT);
    expect(JSON.stringify(events)).not.toContain("sk-");
    await llm.destroy();
  });
});
