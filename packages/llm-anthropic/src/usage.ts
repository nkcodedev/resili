import { normalizeUsage, type LlmUsage } from "@resili/llm";

import type { AnthropicUsage } from "./anthropic-types";

/**
 * Maps Anthropic usage to {@link LlmUsage}.
 *
 * Missing usage is not estimated. Counts that Anthropic omitted become `0`
 * because {@link LlmUsage} requires numbers. Cache/thinking details go on
 * `dimensions` and are not priced by this adapter.
 *
 * @internal
 */
export function mapUsage(usage: AnthropicUsage | null | undefined): LlmUsage {
  if (usage === undefined || usage === null) {
    return normalizeUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  }

  const cacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
  const hasCacheCreation = cacheCreation !== undefined && cacheCreation !== null;
  const hasCacheRead = cacheRead !== undefined && cacheRead !== null;
  const hasThinking = thinkingTokens !== undefined && thinkingTokens !== null;

  return normalizeUsage({
    ...(usage.input_tokens === undefined || usage.input_tokens === null
      ? {}
      : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined || usage.output_tokens === null
      ? {}
      : { outputTokens: usage.output_tokens }),
    ...(hasCacheCreation || hasCacheRead || hasThinking
      ? {
          dimensions: {
            ...(hasCacheCreation ? { cacheCreationInputTokens: cacheCreation } : {}),
            ...(hasCacheRead ? { cacheReadInputTokens: cacheRead } : {}),
            ...(hasThinking ? { thinkingTokens } : {}),
          },
        }
      : {}),
  });
}
