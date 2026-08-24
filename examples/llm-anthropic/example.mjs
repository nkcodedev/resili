/**
 * Runnable locally. Not executed in CI.
 *
 * ANTHROPIC_API_KEY must be set. Pricing rows are examples only.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createAnthropicProvider } from "@resili/llm-anthropic";

const apiKey = process.env["ANTHROPIC_API_KEY"];

if (typeof apiKey !== "string" || apiKey.length === 0) {
  throw new Error("Set ANTHROPIC_API_KEY in the environment.");
}

const anthropic = new Anthropic({ apiKey });

const llm = createLlmClient({
  provider: createAnthropicProvider({
    client: anthropic,
    model: "claude-sonnet-4-5",
    maxTokens: 128,
  }),
  model: "claude-sonnet-4-5",
  timeout: { perAttemptMs: 15_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputPerMillionTokensUsd: 3,
      outputPerMillionTokensUsd: 15,
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
