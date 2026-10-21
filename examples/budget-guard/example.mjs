/**
 * Offline Budget Guard demonstration.
 *
 * Uses the workspace build of @resili/llm. No API key and no network.
 *
 *   pnpm --filter @resili/llm build
 *   node examples/budget-guard/example.mjs
 */
import {
  LlmBudgetExceededError,
  createLlmClient,
  createPricingResolver,
  defineProvider,
} from "../../packages/llm/dist/index.js";

let providerCalls = 0;

const provider = defineProvider({
  name: "example",
  async execute(request) {
    providerCalls += 1;

    return {
      provider: "example",
      model: request.model,
      content: "provider was called",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      finishReason: "stop",
    };
  },
});

const llm = createLlmClient({
  provider,
  model: "example-small",
  pricing: createPricingResolver([
    {
      provider: "example",
      model: "example-small",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 1,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.01 },
});

try {
  await llm.generate({
    input: "This text is not sent to a vendor.",
    estimatedInputTokens: 20_000,
    estimatedOutputTokens: 20_000,
  });
  console.log("unexpected success");
} catch (error) {
  if (!(error instanceof LlmBudgetExceededError)) {
    throw error;
  }

  console.log("Budget Guard rejected the request before the provider ran.");
  console.log(`provider calls: ${providerCalls}`);
  console.log(`limit kind: ${error.limitKind}`);
  console.log(`attempted micro-USD: ${error.attemptedMicroUsd}`);
  console.log(`limit micro-USD: ${error.limitMicroUsd}`);
} finally {
  await llm.destroy();
}
