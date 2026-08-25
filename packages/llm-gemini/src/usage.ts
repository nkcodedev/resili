import { normalizeUsage, type LlmUsage } from "@resili/llm";

import type { GeminiUsageMetadata } from "./gemini-types";

/**
 * Maps Gemini `usageMetadata` to {@link LlmUsage}.
 *
 * Missing usage is not estimated. Omitted counts become `0` because
 * {@link LlmUsage} requires numbers. Extra Gemini dimensions go on
 * `dimensions` and are not priced by this adapter.
 *
 * @internal
 */
export function mapUsage(usage: GeminiUsageMetadata | null | undefined): LlmUsage {
  if (usage === undefined || usage === null) {
    return normalizeUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  }

  const cachedTokens = usage.cachedContentTokenCount;
  const thoughtsTokens = usage.thoughtsTokenCount;
  const toolUsePromptTokens = usage.toolUsePromptTokenCount;
  const hasDimensions =
    cachedTokens !== undefined || thoughtsTokens !== undefined || toolUsePromptTokens !== undefined;

  return normalizeUsage({
    ...(usage.promptTokenCount === undefined ? {} : { inputTokens: usage.promptTokenCount }),
    ...(usage.candidatesTokenCount === undefined
      ? {}
      : { outputTokens: usage.candidatesTokenCount }),
    ...(usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount }),
    ...(hasDimensions
      ? {
          dimensions: {
            ...(cachedTokens === undefined ? {} : { cachedContentTokenCount: cachedTokens }),
            ...(thoughtsTokens === undefined ? {} : { thoughtsTokenCount: thoughtsTokens }),
            ...(toolUsePromptTokens === undefined
              ? {}
              : { toolUsePromptTokenCount: toolUsePromptTokens }),
          },
        }
      : {}),
  });
}
