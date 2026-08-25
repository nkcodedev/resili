/**
 * Runnable locally. Not executed in CI.
 *
 * OPENAI_API_KEY must be set. Pricing rows are examples only.
 *
 * timeout.perAttemptMs is the FULL stream attempt, including time spent
 * waiting for the consumer to pull chunks. It is not TTFB or idle-chunk timeout.
 */
import OpenAI from "openai";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const apiKey = process.env["OPENAI_API_KEY"];

if (typeof apiKey !== "string" || apiKey.length === 0) {
  throw new Error("Set OPENAI_API_KEY in the environment.");
}

const openai = new OpenAI({ apiKey });

const llm = createLlmClient({
  provider: createOpenAiProvider({
    client: openai,
    model: "gpt-4.1-mini",
  }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]),
});

const stream = llm.stream({
  input: "Reply with a single sentence about circuit breakers.",
});

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }

  if (event.type === "completed") {
    process.stdout.write("\n");
    console.log({
      usage: event.usage,
      costUsd: event.cost?.totalCostUsd,
      finishReason: event.finishReason,
    });
  }
}

const result = await stream.result();
console.log({ resultFinishReason: result.finishReason });

await llm.destroy();
