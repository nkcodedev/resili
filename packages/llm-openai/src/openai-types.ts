/**
 * Per-request options passed as the second argument to
 * `client.chat.completions.create(body, options)`.
 *
 * Matches OpenAI Node SDK v4–v7 `RequestOptions` for the fields Resili needs.
 *
 * @public
 */
export interface OpenAiRequestOptions {
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
  readonly timeout?: number;
}

/**
 * Chat Completions request body used by this adapter.
 *
 * @public
 */
export interface OpenAiChatCompletionCreateParams {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "user";
    readonly content: string;
  }[];
}

/**
 * Structural OpenAI Chat Completions client.
 *
 * Compatible with `openai` SDK instances: `client.chat.completions.create`.
 * This package does not construct or store API keys.
 *
 * @public
 */
export interface OpenAiClient {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAiChatCompletionCreateParams,
        options?: OpenAiRequestOptions,
      ): Promise<OpenAiChatCompletion>;
    };
  };
}

/**
 * Minimal Chat Completions response fields this adapter reads.
 *
 * @public
 */
export interface OpenAiChatCompletion {
  readonly model?: string;
  readonly choices?: readonly OpenAiChatCompletionChoice[];
  readonly usage?: OpenAiCompletionUsage | null;
}

/**
 * @public
 */
export interface OpenAiChatCompletionChoice {
  readonly finish_reason?: string | null;
  readonly message?: {
    readonly content?: string | null;
  };
}

/**
 * OpenAI usage payload. Field names follow the Chat Completions API.
 *
 * @public
 */
export interface OpenAiCompletionUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
  };
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number;
  };
}
