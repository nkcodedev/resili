/**
 * Per-request options passed as the second argument to
 * `client.messages.create(body, options)`.
 *
 * Matches `@anthropic-ai/sdk` `RequestOptions` for the fields Resili needs.
 * Inspected against `@anthropic-ai/sdk@0.120.0`.
 *
 * @public
 */
export interface AnthropicRequestOptions {
  readonly signal?: AbortSignal | null;
  readonly maxRetries?: number;
  readonly timeout?: number;
}

/**
 * Messages API request body used by this adapter.
 *
 * @public
 */
export interface AnthropicMessageCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly {
    readonly role: "user";
    readonly content: string;
  }[];
}

/**
 * Structural Anthropic Messages client.
 *
 * Compatible with `@anthropic-ai/sdk` instances: `client.messages.create`.
 * This package does not construct or store API keys.
 *
 * @public
 */
export interface AnthropicClient {
  readonly messages: {
    create(
      body: AnthropicMessageCreateParams,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessage>;
  };
}

/**
 * Minimal Messages response fields this adapter reads.
 *
 * @public
 */
export interface AnthropicMessage {
  readonly model?: string;
  readonly content?: readonly AnthropicContentBlock[] | string;
  readonly stop_reason?: string | null;
  readonly usage?: AnthropicUsage | null;
}

/**
 * Anthropic content block. Alpha 1 reads `type: "text"` only.
 *
 * @public
 */
export interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
}

/**
 * Anthropic usage payload. Field names follow the Messages API.
 *
 * @public
 */
export interface AnthropicUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly output_tokens_details?: {
    readonly thinking_tokens?: number | null;
  } | null;
}
