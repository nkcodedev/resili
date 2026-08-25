import type { Context } from "@resili/core";

/**
 * Provider-neutral identity for an LLM backend.
 *
 * Values are opaque strings. This package never interprets vendor SDK names.
 *
 * @public
 */
export interface LlmProviderIdentity {
  /**
   * Logical provider name, for example `"example"` or `"openai"`.
   */
  readonly name: string;
}

/**
 * Normalized generation finish reason.
 *
 * @public
 */
export type LlmFinishReason =
  "stop" | "length" | "content_filter" | "tool_calls" | "error" | "unknown";

/**
 * Normalized token usage.
 *
 * Additional numeric dimensions may be supplied in {@link LlmUsage.dimensions}
 * without changing this contract. Unknown dimension keys are preserved and
 * ignored by cost calculation until a pricing model understands them.
 *
 * @public
 */
export interface LlmUsage {
  /**
   * Prompt / input tokens.
   */
  readonly inputTokens: number;

  /**
   * Completion / output tokens.
   */
  readonly outputTokens: number;

  /**
   * Total tokens when the provider reports them. When omitted, Resili derives
   * `inputTokens + outputTokens`.
   */
  readonly totalTokens: number;

  /**
   * Optional extra numeric usage dimensions (cached tokens, reasoning tokens, …).
   */
  readonly dimensions?: Readonly<Record<string, number>>;
}

/**
 * Provider-neutral generation request.
 *
 * Adapters must not put API keys or authorization material on this object.
 *
 * @public
 */
export interface LlmRequest {
  /**
   * Provider name copied from {@link LlmProviderIdentity.name}.
   */
  readonly provider: string;

  /**
   * Model identifier understood by the provider adapter.
   */
  readonly model: string;

  /**
   * Caller input. Never copied into events or metrics by default.
   */
  readonly input: string;

  /**
   * Optional pre-flight input token estimate used by Budget Guard.
   */
  readonly estimatedInputTokens?: number;

  /**
   * Optional pre-flight output token estimate used by Budget Guard.
   */
  readonly estimatedOutputTokens?: number;

  /**
   * Low-cardinality caller metadata. Must not contain secrets or prompt text.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Provider-neutral generation response.
 *
 * @public
 */
export interface LlmResponse {
  /**
   * Provider that produced the response.
   */
  readonly provider: string;

  /**
   * Model reported by the provider when available, otherwise the request model.
   */
  readonly model: string;

  /**
   * Generated text. Never copied into events or metrics by default.
   */
  readonly content: string;

  /**
   * Normalized usage. Missing counts are treated as zero.
   */
  readonly usage: LlmUsage;

  /**
   * Why generation stopped.
   */
  readonly finishReason: LlmFinishReason;
}

/**
 * Provider adapter contract.
 *
 * Implementations wrap a vendor SDK and normalize into {@link LlmRequest} /
 * {@link LlmResponse}. They must honor `ctx.signal` for cancellation.
 *
 * @public
 */
export interface LlmProvider {
  /**
   * Stable provider name used for pricing, events, and budget scope defaults.
   */
  readonly name: string;

  /**
   * Executes one normalized generation request.
   */
  execute(request: LlmRequest, ctx: Context): Promise<LlmResponse>;

  /**
   * Optional streaming generation. Missing `stream` is not an error until
   * `LlmClient.stream()` is called.
   *
   * Frames may include metadata without text. Only non-empty `text` is yielded
   * to consumers as `text-delta`.
   */
  stream?(request: LlmRequest, ctx: Context): Promise<AsyncIterable<LlmProviderStreamFrame>>;
}

/**
 * Adapter-normalized streaming frame. Not a public consumer event.
 *
 * @public
 */
export interface LlmProviderStreamFrame {
  /**
   * Incremental or cumulative text. Empty/omitted frames do not commit retry.
   */
  readonly text?: string;

  /**
   * Model identity when the provider reports it mid-stream.
   */
  readonly model?: string;

  /**
   * Finish reason when the provider reports it.
   */
  readonly finishReason?: LlmFinishReason;

  /**
   * Partial or final usage. Missing counts are not estimated.
   */
  readonly usage?: Partial<LlmUsage>;
}
