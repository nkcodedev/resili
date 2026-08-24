import type { LlmFinishReason } from "@resili/llm";

/**
 * Maps Anthropic Messages `stop_reason` to Resili's normalized reason.
 *
 * Values follow `@anthropic-ai/sdk` `StopReason` (inspected 0.120.0):
 * `end_turn` | `max_tokens` | `stop_sequence` | `tool_use` | `pause_turn` |
 * `refusal` | `model_context_window_exceeded`.
 *
 * Unknown values map to `"unknown"` and never throw.
 *
 * @internal
 */
export function mapFinishReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}
