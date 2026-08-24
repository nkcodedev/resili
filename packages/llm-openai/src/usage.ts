import { normalizeUsage, type LlmUsage } from "@resili/llm";

import type { OpenAiCompletionUsage } from "./openai-types";

/**
 * Maps OpenAI usage to {@link LlmUsage}.
 *
 * Missing usage is not estimated. Counts that OpenAI omitted become `0` because
 * {@link LlmUsage} requires numbers. Extra details go on `dimensions`.
 *
 * @internal
 */
export function mapUsage(usage: OpenAiCompletionUsage | null | undefined): LlmUsage {
  if (usage === undefined || usage === null) {
    return normalizeUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  return normalizeUsage({
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(cachedTokens === undefined && reasoningTokens === undefined
      ? {}
      : {
          dimensions: {
            ...(cachedTokens === undefined ? {} : { cachedTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          },
        }),
  });
}
