import type { LlmFinishReason } from "@resili/llm";

/**
 * Maps Gemini `FinishReason` / `promptFeedback.blockReason` to Resili.
 *
 * Values follow `@google/genai@2.18.0` `FinishReason`. Unknown values map to
 * `"unknown"` and never throw.
 *
 * @internal
 */
export function mapFinishReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "IMAGE_PROHIBITED_CONTENT":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "tool_calls";
    default:
      return "unknown";
  }
}
