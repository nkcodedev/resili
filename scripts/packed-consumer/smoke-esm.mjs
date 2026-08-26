import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createClient, RESILI_VERSION, noopMetrics } from "@resili/core";
import { createFetch } from "@resili/fetch";
import { createAxios } from "@resili/axios";
import { createUndici } from "@resili/undici";
import {
  createLlmClient,
  createPricingResolver,
  defineProvider,
  isLlmError,
  LlmError,
} from "@resili/llm";
import { createOpenAiProvider, OPENAI_SDK_MAX_RETRIES } from "@resili/llm-openai";
import { createAnthropicProvider, ANTHROPIC_SDK_MAX_RETRIES } from "@resili/llm-anthropic";
import { createGeminiProvider, GEMINI_SDK_HTTP_ATTEMPTS } from "@resili/llm-gemini";

const require = createRequire(import.meta.url);
const corePkg = require("@resili/core/package.json");
const llmPkg = require("@resili/llm/package.json");

class FakeClock {
  #now = 0;
  #nextHandle = 1;
  #timers = new Map();

  now() {
    return this.#now;
  }

  setTimeout(callback, ms) {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + ms, callback });
    return handle;
  }

  clearTimeout(handle) {
    this.#timers.delete(handle);
  }

  tick(ms) {
    this.#now += ms;
    for (const [handle, timer] of [...this.#timers].sort(([a], [b]) => a - b)) {
      if (timer.at <= this.#now && this.#timers.delete(handle)) {
        timer.callback();
      }
    }
  }
}

function hangingAttemptProvider(nextAttempt, hangBeforeTextAttempts) {
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
              next() {
                return new Promise(() => undefined);
              },
              async return() {
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
            next() {
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
                  value: {
                    finishReason: "stop",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });
}

async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function coreSmoke() {
  assert.equal(RESILI_VERSION, corePkg.version);
  assert.equal(RESILI_VERSION, "0.2.0-beta.1");
  assert.equal(llmPkg.version, "0.1.0-beta.1");
  const metrics = {
    ...noopMetrics,
    counter() {
      return { inc() {} };
    },
    histogram() {
      return { observe() {} };
    },
    gauge() {
      return { set() {} };
    },
  };
  const client = createClient(async () => "ok", { metrics });
  assert.equal(await client.call(), "ok");
  const stats = client.stats();
  assert.equal(stats.totals.calls, 1);
  assert.equal(stats.totals.successes, 1);
  assert.equal(client.health().status, "healthy");
  assert.equal("circuit" in stats, false);
  assert.equal("openCircuits" in client.health(), false);
  let attempts = 0;
  const retrying = createClient(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient");
      }
      return "retried";
    },
    {
      retry: {
        maxAttempts: 2,
        jitter: "none",
        baseDelayMs: 0,
        retryOn: (outcome) => outcome.status === "error",
      },
    },
  );
  assert.equal(await retrying.call(), "retried");
  assert.equal(attempts, 2);
  const clock = new FakeClock();
  const timed = createClient(() => new Promise(() => undefined), {
    clock,
    timeout: { perAttemptMs: 10 },
  });
  const pending = timed.call();
  clock.tick(10);
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.throws(
    () =>
      createClient(async () => "x", {
        timeout: { perAttemptMs: 10, deadlineMs: 20 },
      }),
    /timeout\.deadlineMs/,
  );
  const deadlineClient = createClient(async () => "unused");
  await assert.rejects(
    deadlineClient.execute(
      (ctx) =>
        new Promise((_resolve, reject) => {
          if (ctx.signal.aborted) {
            reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted"));
            return;
          }
          ctx.signal.addEventListener(
            "abort",
            () => {
              reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
      { deadlineMs: 40 },
    ),
    (error) => error instanceof Error,
  );
  await client.destroy();
  await retrying.destroy();
  await timed.destroy();
  await deadlineClient.destroy();
}

async function fetchSmoke() {
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") {
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const origin = await listen(server);
  try {
    const resilientFetch = createFetch();
    const unsub = resilientFetch.on("CallStarted", () => undefined);
    unsub();
    const response = await resilientFetch(`${origin}/ok`);
    assert.equal(await response.text(), "ok");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(resilientFetch(`${origin}/hang`, { signal: controller.signal }), {
      name: "AbortError",
    });
    await resilientFetch.destroy();
  } finally {
    await close(server);
  }
}

async function axiosSmoke() {
  let calls = 0;
  const axios = createAxios({
    axios: async (config) => {
      calls += 1;
      return {
        data: { ok: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    },
  });
  const unsub = axios.on("CallStarted", () => undefined);
  unsub();
  const result = await axios.get("/users");
  assert.equal(result.status, 200);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(axios.get("/users", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
  await axios.destroy();
}

async function undiciSmoke() {
  let calls = 0;
  const request = createUndici({
    request: async (options) => {
      calls += 1;
      return { statusCode: 200, headers: {}, body: "ok", ...options };
    },
  });
  const unsub = request.on("CallStarted", () => undefined);
  unsub();
  const result = await request({ origin: "https://example.com", path: "/users" });
  assert.equal(result.statusCode, 200);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    request({ origin: "https://example.com", path: "/users", signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  await request.destroy();
}

async function llmSmoke() {
  const pricing = createPricingResolver([
    {
      provider: "example",
      model: "model-a",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]);
  const provider = defineProvider({
    name: "example",
    async execute() {
      return {
        provider: "example",
        model: "model-a",
        content: "hello",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    },
    async stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { text: "hello" };
          yield {
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      };
    },
  });
  const llm = createLlmClient({
    provider,
    model: "model-a",
    pricing,
    budget: { maxCostPerRequestUsd: 1 },
  });
  const generated = await llm.generate({
    input: "Hi",
    estimatedInputTokens: 1,
    estimatedOutputTokens: 1,
  });
  assert.equal(generated.response.content, "hello");
  assert.ok(generated.cost !== undefined);
  const stream = llm.stream({
    input: "Hi",
    estimatedInputTokens: 1,
    estimatedOutputTokens: 1,
  });
  const texts = [];
  for await (const event of stream) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["hello"]);
  const result = await stream.result();
  assert.equal(result.finishReason, "stop");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(llm.generate({ input: "Hi", signal: controller.signal }), {
    name: "AbortError",
  });
  await llm.destroy();
}

async function openaiSmoke() {
  assert.equal(OPENAI_SDK_MAX_RETRIES, 0);
  let seenMaxRetries;
  const client = {
    chat: {
      completions: {
        async create(body, options) {
          seenMaxRetries = options?.maxRetries;
          if (body.stream) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { model: "gpt-4.1-mini", choices: [{ delta: { content: "Hi" } }] };
                yield {
                  choices: [{ delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                };
              },
            };
          }
          return {
            model: "gpt-4.1-mini",
            choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          };
        },
      },
    },
  };
  const llm = createLlmClient({
    provider: createOpenAiProvider({ client, model: "gpt-4.1-mini" }),
    model: "gpt-4.1-mini",
  });
  assert.equal((await llm.generate({ input: "Hello" })).response.content, "Hi");
  assert.equal(seenMaxRetries, 0);
  const texts = [];
  for await (const event of llm.stream({ input: "Hello" })) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["Hi"]);
  await llm.destroy();
}

async function anthropicSmoke() {
  assert.equal(ANTHROPIC_SDK_MAX_RETRIES, 0);
  let seenMaxRetries;
  const MODEL = "claude-sonnet-4-5";
  const client = {
    messages: {
      async create(body, options) {
        seenMaxRetries = options?.maxRetries;
        if (body.stream) {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_start",
                message: { model: MODEL, usage: { input_tokens: 2, output_tokens: 0 } },
              };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } };
              yield {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 1 },
              };
            },
          };
        }
        return {
          model: MODEL,
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        };
      },
    },
  };
  const llm = createLlmClient({
    provider: createAnthropicProvider({ client, model: MODEL, maxTokens: 32 }),
    model: MODEL,
  });
  assert.equal((await llm.generate({ input: "Hello" })).response.content, "Hi");
  assert.equal(seenMaxRetries, 0);
  const texts = [];
  for await (const event of llm.stream({ input: "Hello" })) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["Hi"]);
  await llm.destroy();
}

async function geminiSmoke() {
  assert.equal(GEMINI_SDK_HTTP_ATTEMPTS, 1);
  let seenAttempts;
  const MODEL = "gemini-2.5-flash";
  const client = {
    models: {
      async generateContent(req) {
        seenAttempts = req?.config?.httpOptions?.retryOptions?.attempts;
        return {
          modelVersion: MODEL,
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hi" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        };
      },
      async generateContentStream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { modelVersion: MODEL, candidates: [{ content: { parts: [{ text: "Hi" }] } }] };
            yield {
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hi" }] } }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
            };
          },
        };
      },
    },
  };
  const llm = createLlmClient({
    provider: createGeminiProvider({ client, model: MODEL }),
    model: MODEL,
  });
  assert.equal((await llm.generate({ input: "Hello" })).response.content, "Hi");
  assert.equal(seenAttempts, 1);
  const texts = [];
  for await (const event of llm.stream({ input: "Hello" })) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["Hi"]);
  await llm.destroy();
}

async function postCommitTimeout() {
  let attempts = 0;
  const clock = new FakeClock();
  const failed = [];
  const llm = createLlmClient({
    provider: hangingAttemptProvider(() => {
      attempts += 1;
      return attempts;
    }, 0),
    model: "model-a",
    clock,
    timeout: { perAttemptMs: 60 },
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
  llm.on("LlmStreamFailed", (event) => {
    failed.push(event);
  });
  const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.type, "text-delta");
  assert.equal(first.value.text, "A1");
  const pending = iterator.next();
  clock.tick(60);
  const error = await pending.then(
    () => undefined,
    (reason) => reason,
  );
  assert.equal(isLlmError(error), true);
  assert.equal(error.classification, "timeout");
  assert.equal(error.retryable, false);
  assert.equal(attempts, 1);
  assert.equal(retryStarted, 0);
  assert.equal(timeoutTriggered, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].type, "LlmStreamFailed");
  assert.equal(failed[0].committed, true);
  assert.equal(failed[0].classification, "timeout");
  assert.equal(failed[0].retryable, false);
  await new Promise((resolve) => {
    globalThis.setTimeout(resolve, 500);
  });
  assert.equal(attempts, 1);
  await llm.destroy();
}

async function preCommitRetry() {
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
  const texts = [];
  const stream = llm.stream({ input: "Hello" });
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  clock.tick(40);
  const event = await first;
  assert.equal(event.value.text, "A2");
  texts.push(event.value.text);
  for await (const next of { [Symbol.asyncIterator]: () => iterator }) {
    if (next.type === "text-delta") {
      texts.push(next.text);
    }
  }
  assert.deepEqual(texts, ["A2"]);
  assert.equal(attempts, 2);
  assert.equal(retryStarted, 1);
  await llm.destroy();
}

async function preCommit429Retry() {
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
        return {
          async *[Symbol.asyncIterator]() {
            yield { text: "ok" };
            yield {
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        };
      },
    }),
    model: "model-a",
    retry: { maxAttempts: 3, backoff: "fixed", jitter: "none", baseDelayMs: 0 },
  });
  const texts = [];
  for await (const event of llm.stream({ input: "Hello" })) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["ok"]);
  assert.equal(attempts, 2);
  await llm.destroy();
}

await coreSmoke();
await fetchSmoke();
await axiosSmoke();
await undiciSmoke();
await llmSmoke();
await openaiSmoke();
await anthropicSmoke();
await geminiSmoke();
await postCommitTimeout();
await preCommitRetry();
await preCommit429Retry();
process.stdout.write("esm packed consumer smoke ok\n");
