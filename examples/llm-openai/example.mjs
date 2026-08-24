/**
 * Runnable locally. Not executed in CI.
 *
 * OPENAI_API_KEY must be set. Pricing rows are examples only.
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
  timeout: { perAttemptMs: 15_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]),
  budget: {
    maxCostPerRequestUsd: 0.5,
    maxAccumulatedCostUsd: 5,
  },
});

const result = await llm.generate({
  input: "Reply with a single word: pong",
  estimatedInputTokens: 20,
  estimatedOutputTokens: 16,
});

console.log({
  content: result.response.content,
  model: result.response.model,
  usage: result.usage,
  estimatedPreflight: "see estimatedInputTokens / estimatedOutputTokens on generate()",
  actualCostUsd: result.cost?.totalCostUsd,
  actualCostMicroUsd: result.cost?.totalCostMicroUsd,
});

await llm.destroy();
