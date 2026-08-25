import assert from "node:assert/strict";
import http from "node:http";
import { createClient, RESILI_VERSION } from "@resili/core";
import { createFetch } from "@resili/fetch";
import { createAxios } from "@resili/axios";
import { createUndici } from "@resili/undici";
import { createLlmClient, defineProvider, isLlmError } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";
import { createAnthropicProvider } from "@resili/llm-anthropic";
import { createGeminiProvider } from "@resili/llm-gemini";

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
  assert.equal(typeof RESILI_VERSION, "string");
  assert.ok(RESILI_VERSION.length > 0);
  const client = createClient(async () => "ok");
  assert.equal(await client.call(), "ok");
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
  await client.destroy();
  await retrying.destroy();
  await timed.destroy();
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
  const llm = createLlmClient({ provider, model: "model-a" });
  const generated = await llm.generate({ input: "Hi" });
  assert.equal(generated.response.content, "hello");
  const stream = llm.stream({ input: "Hi" });
  const texts = [];
  for await (const event of stream) {
    if (event.type === "text-delta") {
      texts.push(event.text);
    }
  }
  assert.deepEqual(texts, ["hello"]);
  const result = await stream.result();
  assert.equal(result.finishReason, "stop");
  await llm.destroy();
}

async function openaiSmoke() {
  const client = {
    chat: {
      completions: {
        async create(body) {
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
  const MODEL = "claude-sonnet-4-5";
  const client = {
    messages: {
      async create(body) {
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
  const MODEL = "gemini-2.5-flash";
  const client = {
    models: {
      async generateContent() {
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
  let retryStarted = 0;
  llm.onCore("RetryStarted", () => {
    retryStarted += 1;
  });
  const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.type, "text-delta");
  assert.equal(first.value.text, "A1");
  const pending = iterator.next();
  clock.tick(40);
  const error = await pending.then(
    () => undefined,
    (reason) => reason,
  );
  assert.equal(isLlmError(error), true);
  assert.equal(error.classification, "timeout");
  assert.equal(error.retryable, false);
  assert.equal(attempts, 1);
  assert.equal(retryStarted, 0);
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
  const iterator = llm.stream({ input: "Hello" })[Symbol.asyncIterator]();
  const first = iterator.next();
  clock.tick(40);
  assert.equal((await first).value.text, "A2");
  const pending = iterator.next();
  clock.tick(40);
  await assert.rejects(pending, { classification: "timeout", retryable: false });
  assert.equal(attempts, 2);
  assert.equal(retryStarted, 1);
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
process.stdout.write("esm packed consumer smoke ok\n");
