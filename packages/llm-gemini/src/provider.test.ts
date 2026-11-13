import { inspect } from "node:util";

import { AbortError, CircuitOpenError, ConfigurationError, TimeoutError } from "@resili/core";
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
  createGeminiProvider,
  GEMINI_SDK_HTTP_ATTEMPTS,
  type GeminiClient,
  type GeminiGenerateContentParameters,
  type GeminiGenerateContentResponse,
} from "./index";

const PROMPT = "SECRET_PROMPT_DO_NOT_LEAK";
const OUTPUT = "SECRET_COMPLETION_DO_NOT_LEAK";
const API_KEY = "AIzaSySecretTestKeyNotReal";
const MODEL = "gemini-2.5-flash";

function response(
  overrides: Partial<GeminiGenerateContentResponse> = {},
): GeminiGenerateContentResponse {
  return {
    modelVersion: MODEL,
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: OUTPUT }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
    },
    ...overrides,
  };
}

function mockClient(
  generateContent: (
    params: GeminiGenerateContentParameters,
  ) => Promise<GeminiGenerateContentResponse>,
): GeminiClient {
  return {
    models: {
      generateContent,
    },
  };
}

function ctx(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

describe("createGeminiProvider", () => {
  it("normalizes a successful generateContent response", async () => {
    const generateContent = vi.fn(() => Promise.resolve(response()));
    const provider = createGeminiProvider({
      client: mockClient(generateContent),
      model: MODEL,
    });

    const result = await provider.execute(
      { provider: "gemini", model: MODEL, input: PROMPT },
      ctx() as never,
    );

    expect(result).toEqual({
      provider: "gemini",
      model: MODEL,
      content: OUTPUT,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      finishReason: "stop",
    });
    expect(generateContent.mock.calls[0]?.[0]).toEqual({
      model: MODEL,
      contents: PROMPT,
      config: {
        abortSignal: expect.any(AbortSignal) as AbortSignal,
        httpOptions: {
          retryOptions: {
            attempts: GEMINI_SDK_HTTP_ATTEMPTS,
          },
        },
      },
    });
    const params = generateContent.mock.calls[0]?.[0] as
      GeminiGenerateContentParameters | undefined;
    expect(params?.config?.httpOptions?.retryOptions?.attempts).toBe(1);
  });

  it("uses the configured model when the request model is empty", async () => {
    const generateContent = vi.fn(() => Promise.resolve(response()));
    const provider = createGeminiProvider({
      client: mockClient(generateContent),
      model: MODEL,
    });

    await provider.execute({ provider: "gemini", model: "  ", input: "x" }, ctx() as never);

    expect(generateContent.mock.calls[0]?.[0]?.model).toBe(MODEL);
  });

  it("uses modelVersion when present and falls back to the request model", async () => {
    const withVersion = createGeminiProvider({
      client: mockClient(() => Promise.resolve(response({ modelVersion: "gemini-2.5-flash-001" }))),
      model: MODEL,
    });
    const withoutVersion = createGeminiProvider({
      client: mockClient(() => Promise.resolve(response({ modelVersion: undefined }))),
      model: MODEL,
    });

    await expect(
      withVersion.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ model: "gemini-2.5-flash-001" });
    await expect(
      withoutVersion.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ model: MODEL });
  });

  it("extracts a single text part", async () => {
    const provider = createGeminiProvider({
      client: mockClient(() => Promise.resolve(response())),
      model: MODEL,
    });

    await expect(
      provider.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ content: OUTPUT });
  });

  it("concatenates multiple text parts and ignores unsupported parts", async () => {
    const provider = createGeminiProvider({
      client: mockClient(() =>
        Promise.resolve(
          response({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    { text: "Hello" },
                    { inlineData: { mimeType: "image/png" } },
                    { thought: true, text: "hidden-thought" },
                    { functionCall: { name: "x" } },
                    { text: " world" },
                  ],
                },
              },
            ],
          }),
        ),
      ),
      model: MODEL,
    });

    await expect(
      provider.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({ content: "Hello world" });
  });

  it("maps usage and extra dimensions without estimating missing counts", async () => {
    const provider = createGeminiProvider({
      client: mockClient(() =>
        Promise.resolve(
          response({
            usageMetadata: {
              promptTokenCount: 8,
              candidatesTokenCount: 2,
              totalTokenCount: 12,
              cachedContentTokenCount: 3,
              thoughtsTokenCount: 1,
              toolUsePromptTokenCount: 2,
            },
          }),
        ),
      ),
      model: MODEL,
    });

    await expect(
      provider.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 12,
        dimensions: {
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 1,
          toolUsePromptTokenCount: 2,
        },
      },
    });
  });

  it("maps missing usage to zeros", async () => {
    const provider = createGeminiProvider({
      client: mockClient(() => Promise.resolve(response({ usageMetadata: undefined }))),
      model: MODEL,
    });

    await expect(
      provider.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
    ).resolves.toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it("maps finish reasons including unknown values", async () => {
    const cases: readonly { readonly reason: string; readonly expected: string }[] = [
      { reason: "STOP", expected: "stop" },
      { reason: "MAX_TOKENS", expected: "length" },
      { reason: "SAFETY", expected: "content_filter" },
      { reason: "NEW_REASON_FROM_GEMINI", expected: "unknown" },
    ];

    for (const { reason, expected } of cases) {
      const provider = createGeminiProvider({
        client: mockClient(() =>
          Promise.resolve(
            response({
              candidates: [{ finishReason: reason, content: { parts: [{ text: "x" }] } }],
            }),
          ),
        ),
        model: MODEL,
      });

      await expect(
        provider.execute({ provider: "gemini", model: MODEL, input: "x" }, ctx() as never),
      ).resolves.toMatchObject({ finishReason: expected });
    }
  });

  it("maps prompt block feedback to content_filter without exposing the raw response", async () => {
    const provider = createGeminiProvider({
      client: mockClient(() =>
        Promise.resolve(
          response({
            candidates: undefined,
            promptFeedback: { blockReason: "SAFETY" },
          }),
        ),
      ),
      model: MODEL,
    });

    const result = await provider.execute(
      { provider: "gemini", model: MODEL, input: "x" },
      ctx() as never,
    );

    expect(result.finishReason).toBe("content_filter");
    expect(result.content).toBe("");
    expect(result).not.toHaveProperty("raw");
    expect(JSON.stringify(result)).not.toContain("candidates");
  });

  it("rejects invalid options", () => {
    expect(() => createGeminiProvider(undefined as never)).toThrow(ConfigurationError);
    expect(() => createGeminiProvider(null as never)).toThrow(ConfigurationError);
    expect(() => createGeminiProvider({} as never)).toThrow(ConfigurationError);
    expect(() => createGeminiProvider({ client: null, model: MODEL } as never)).toThrow(
      ConfigurationError,
    );
    expect(() => createGeminiProvider({ client: {}, model: MODEL } as never)).toThrow(
      ConfigurationError,
    );
    expect(() =>
      createGeminiProvider({
        client: { models: {} } as never,
        model: MODEL,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createGeminiProvider({
        client: mockClient(() => Promise.resolve(response())),
        model: "   ",
      }),
    ).toThrow(ConfigurationError);
  });

  async function executeFailing(error: unknown): Promise<unknown> {
    const provider = createGeminiProvider({
      client: mockClient(() => {
        throw error instanceof Error ? error : new Error("non-error");
      }),
      model: MODEL,
    });

    try {
      await provider.execute({ provider: "gemini", model: MODEL, input: PROMPT }, ctx() as never);
      return undefined;
    } catch (caught) {
      return caught;
    }
  }

  it("maps authentication errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("401"), {
        name: "ApiError",
        status: 401,
        error: { status: "UNAUTHENTICATED" },
      }),
    );

    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ classification: "authentication", retryable: false });
    expect(isLlmErrorRetryable(mapped)).toBe(false);
    expect(JSON.stringify(mapped)).not.toContain(PROMPT);
    expect(JSON.stringify(mapped)).not.toContain(API_KEY);
  });

  it("maps authorization errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("403"), { status: 403, error: { status: "PERMISSION_DENIED" } }),
    );

    expect(mapped).toMatchObject({ classification: "authorization", retryable: false });
  });

  it("maps invalid request errors", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("400"), { status: 400, error: { status: "INVALID_ARGUMENT" } }),
    );

    expect(mapped).toMatchObject({ classification: "invalid_request", retryable: false });
  });

  it("maps rate limit / quota errors as retryable", async () => {
    const headers = { get: (name: string) => (name === "retry-after" ? "2" : null) };
    const mapped = await executeFailing(
      Object.assign(new Error("429"), {
        status: 429,
        error: { status: "RESOURCE_EXHAUSTED" },
        headers,
      }),
    );

    expect(mapped).toMatchObject({
      classification: "rate_limited",
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it("maps timeouts", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("deadline"), { status: 504, error: { status: "DEADLINE_EXCEEDED" } }),
    );

    expect(mapped).toMatchObject({ classification: "timeout", retryable: true });
  });

  it("maps network errors", async () => {
    const mapped = await executeFailing(Object.assign(new Error("reset"), { code: "ECONNRESET" }));

    expect(mapped).toMatchObject({ classification: "network_transient", retryable: true });
  });

  it("maps overloaded and server errors", async () => {
    await expect(
      executeFailing(
        Object.assign(new Error("503"), { status: 503, error: { status: "UNAVAILABLE" } }),
      ),
    ).resolves.toMatchObject({ classification: "overloaded", retryable: true });

    await expect(
      executeFailing(Object.assign(new Error("500"), { status: 500 })),
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

  it("normalizes abort errors to AbortError without keeping the raw provider error", async () => {
    const abort = Object.assign(new Error(`aborted ${API_KEY}`), {
      name: "AbortError",
      status: 499,
      headers: { "x-goog-api-key": API_KEY },
      error: { message: API_KEY, details: [{ debugInfo: API_KEY }] },
    });
    const mapped = await executeFailing(abort);

    expect(mapped).toBeInstanceOf(AbortError);
    expect(mapped).toMatchObject({ code: "ERR_ABORTED" });
    expect((mapped as AbortError).cause).not.toBe(abort);
    expect((mapped as AbortError).reason).not.toBe(abort);
    assertNoSecret(mapped, API_KEY);
  });

  it("preserves a caller AbortError and its reason", async () => {
    const caller = new AbortError({ reason: "user-stop" });
    const mapped = await executeFailing(caller);

    expect(mapped).toBe(caller);
    expect((mapped as AbortError).code).toBe("ERR_ABORTED");
    expect((mapped as AbortError).reason).toBe("user-stop");
  });

  it("does not treat an unrelated HTTP 499 as caller cancellation", async () => {
    const mapped = await executeFailing(
      Object.assign(new Error("upstream dependency failed"), {
        status: 499,
        error: { status: "INTERNAL", message: "upstream dependency failed" },
      }),
    );

    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).not.toBeInstanceOf(AbortError);
    expect(mapped).toMatchObject({ classification: "unknown", code: "ERR_LLM_UNKNOWN" });
  });

  it("normalizes HTTP 499 CANCELLED and Client Closed Request errors", async () => {
    const cancelled = Object.assign(new Error("The operation was cancelled."), {
      status: 499,
      error: { status: "CANCELLED", message: API_KEY },
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const cancelledMapped = await executeFailing(cancelled);

    expect(cancelledMapped).toBeInstanceOf(AbortError);
    expect(cancelledMapped).toMatchObject({ code: "ERR_ABORTED" });
    expect((cancelledMapped as AbortError).cause).toMatchObject({
      status: 499,
      code: "CANCELLED",
    });
    assertNoSecret(cancelledMapped, API_KEY);

    const closed = Object.assign(new Error("Client Closed Request"), {
      status: 499,
      requestID: `req-${API_KEY}`,
      error: { message: `nested ${API_KEY}`, details: [API_KEY] },
    });
    const closedMapped = await executeFailing(closed);

    expect(closedMapped).toBeInstanceOf(AbortError);
    expect(closedMapped).toMatchObject({ code: "ERR_ABORTED" });
    expect((closedMapped as AbortError).cause).toMatchObject({ status: 499 });
    expect((closedMapped as AbortError).cause).not.toBe(closed);
    assertNoSecret(closedMapped, API_KEY);
  });
});

describe("Gemini HTTP 499 circuit breaker", () => {
  function clientFor(error: Error) {
    let calls = 0;
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(() => {
          calls += 1;

          return Promise.reject(error);
        }),
        model: MODEL,
      }),
      model: MODEL,
      circuitBreaker: {
        minimumThroughput: 1,
        failureRateThreshold: 50,
        resetTimeoutMs: 60_000,
      },
    });

    return { llm, calls: () => calls };
  }

  it("does not open the circuit after HTTP 499 with CANCELLED", async () => {
    const { llm, calls } = clientFor(
      Object.assign(new Error("The operation was cancelled."), {
        status: 499,
        error: { status: "CANCELLED" },
      }),
    );

    await expect(llm.generate({ input: "Hello" })).rejects.toMatchObject({ code: "ERR_ABORTED" });
    await expect(llm.generate({ input: "Hello" })).rejects.toMatchObject({ code: "ERR_ABORTED" });
    expect(calls()).toBe(2);
    await llm.destroy();
  });

  it("does not open the circuit after HTTP 499 Client Closed Request", async () => {
    const { llm, calls } = clientFor(
      Object.assign(new Error("Client Closed Request"), { status: 499 }),
    );

    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(AbortError);
    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(AbortError);
    expect(calls()).toBe(2);
    await llm.destroy();
  });

  it("opens the circuit after an unrelated HTTP 499", async () => {
    const { llm, calls } = clientFor(
      Object.assign(new Error("upstream dependency failed"), {
        status: 499,
        error: { status: "INTERNAL" },
      }),
    );

    await expect(llm.generate({ input: "Hello" })).rejects.toMatchObject({
      code: "ERR_LLM_UNKNOWN",
    });
    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls()).toBe(1);
    await llm.destroy();
  });
});

function assertNoSecret(error: unknown, secret: string): void {
  const abort = error as AbortError;
  const rendered = [
    abort.message,
    inspect(abort, { depth: 8 }),
    inspect(abort.cause, { depth: 8 }),
    inspect(abort.reason, { depth: 8 }),
    JSON.stringify(abort),
    JSON.stringify(abort.cause),
    JSON.stringify(abort.reason),
  ].join("\n");

  expect(rendered).not.toContain(secret);
  expect(rendered).not.toContain(PROMPT);
}

describe("createLlmClient + Gemini provider", () => {
  const pricing = createPricingResolver([
    {
      provider: "gemini",
      model: MODEL,
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]);

  it("records usage and example cost through the LLM client", async () => {
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(() => Promise.resolve(response())),
        model: MODEL,
      }),
      model: MODEL,
      pricing,
    });

    const result = await llm.generate({ input: "Hello" });

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(result.cost?.totalCostMicroUsd).toBe(10 + 20);
    expect(result.response.provider).toBe("gemini");
    expect(result.response).not.toHaveProperty("raw");
    await llm.destroy();
  });

  it("rejects through Budget Guard before calling Gemini", async () => {
    let called = 0;
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(() => {
          called += 1;
          return Promise.resolve(response());
        }),
        model: MODEL,
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
      provider: createGeminiProvider({
        client: mockClient((params) => {
          seenSignal = params.config?.abortSignal;

          return new Promise((_resolve, reject) => {
            params.config?.abortSignal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }),
        model: MODEL,
      }),
      model: MODEL,
      timeout: { perAttemptMs: 20 },
    });

    await expect(llm.generate({ input: "Hello" })).rejects.toBeInstanceOf(TimeoutError);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    await llm.destroy();
  });

  it("retries retryable Gemini errors through Resili, not the SDK", async () => {
    let attempts = 0;
    const generateContent = vi.fn((params: GeminiGenerateContentParameters) => {
      attempts += 1;
      expect(params.config?.httpOptions?.retryOptions?.attempts).toBe(GEMINI_SDK_HTTP_ATTEMPTS);

      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("429"), { status: 429, error: { status: "RESOURCE_EXHAUSTED" } }),
        );
      }

      return Promise.resolve(response());
    });
    const llm = createLlmClient({
      provider: createGeminiProvider({
        client: mockClient(generateContent),
        model: MODEL,
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
      provider: createGeminiProvider({
        client: mockClient(() => Promise.resolve(response())),
        model: MODEL,
      }),
      model: MODEL,
    });
    llm.on("LlmRequestStarted", (event) => events.push(event));
    llm.on("LlmRequestCompleted", (event) => events.push(event));
    llm.on("LlmUsageRecorded", (event) => events.push(event));

    await llm.generate({ input: PROMPT });

    expect(JSON.stringify(events)).not.toContain(PROMPT);
    expect(JSON.stringify(events)).not.toContain(OUTPUT);
    expect(JSON.stringify(events)).not.toContain("AIza");
    await llm.destroy();
  });
});
