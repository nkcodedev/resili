/**
 * Runnable locally. Not executed in CI.
 *
 * GEMINI_API_KEY must be set. Pricing rows are examples only.
 *
 * timeout.perAttemptMs is the FULL stream attempt, including consumer pull wait.
 * Gemini may bill tokens even if the client aborts.
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
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 2, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
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
    console.log({ usage: event.usage, costUsd: event.cost?.totalCostUsd });
  }
}

await stream.result();
await llm.destroy();
