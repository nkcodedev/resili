import type { LlmFinishReason } from "@resili/llm";

/**
 * Maps OpenAI Chat Completions `finish_reason` to Resili's normalized reason.
 *
 * @internal
 */
export function mapFinishReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "unknown";
  }
}
