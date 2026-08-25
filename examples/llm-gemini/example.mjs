/**
 * Runnable locally. Not executed in CI.
 *
 * GEMINI_API_KEY must be set. Pricing rows are examples only.
 */
import { GoogleGenAI } from "@google/genai";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createGeminiProvider } from "@resili/llm-gemini";

const apiKey = process.env["GEMINI_API_KEY"];

if (typeof apiKey !== "string" || apiKey.length === 0) {
  throw new Error("Set GEMINI_API_KEY in the environment.");
}

const ai = new GoogleGenAI({ apiKey });

const llm = createLlmClient({
  provider: createGeminiProvider({
    client: ai,
    model: "gemini-2.5-flash",
  }),
  model: "gemini-2.5-flash",
  timeout: { perAttemptMs: 15_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
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
