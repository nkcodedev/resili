/**
 * Runnable locally. Not executed in CI.
 *
 * ANTHROPIC_API_KEY must be set. Pricing rows are examples only.
 *
 * timeout.perAttemptMs is the FULL stream attempt, including consumer pull wait.
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
    maxTokens: 256,
  }),
  model: "claude-sonnet-4-5",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputPerMillionTokensUsd: 3,
      outputPerMillionTokensUsd: 15,
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
    console.log({ usage: event.usage, costUsd: event.cost?.totalCostUsd });
  }
}

await stream.result();
await llm.destroy();
