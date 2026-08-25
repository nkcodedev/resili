/**
 * Per-request HTTP retry options on `@google/genai` `HttpOptions.retryOptions`.
 *
 * Inspected against `@google/genai@2.18.0`. `attempts` includes the original
 * request. `0` or `1` means no retries. The SDK default is `5`.
 *
 * @public
 */
export interface GeminiHttpRetryOptions {
  readonly attempts?: number;
}

/**
 * Subset of `@google/genai` `HttpOptions` used to disable SDK retries.
 *
 * @public
 */
export interface GeminiHttpOptions {
  readonly retryOptions?: GeminiHttpRetryOptions;
}

/**
 * Subset of `@google/genai` `GenerateContentConfig`.
 *
 * Abort uses `abortSignal` (not `signal`). Retry uses
 * `httpOptions.retryOptions.attempts`.
 *
 * @public
 */
export interface GeminiGenerateContentConfig {
  readonly abortSignal?: AbortSignal;
  readonly httpOptions?: GeminiHttpOptions;
}

/**
 * `models.generateContent` parameters used by this adapter.
 *
 * `contents` is a plain string (single user text). Inspected against
 * `@google/genai@2.18.0` `GenerateContentParameters`.
 *
 * @public
 */
export interface GeminiGenerateContentParameters {
  readonly model: string;
  readonly contents: string;
  readonly config?: GeminiGenerateContentConfig;
}

/**
 * Structural Gemini client: `client.models.generateContent`.
 *
 * Compatible with `GoogleGenAI` from `@google/genai`. This package does not
 * construct the client or store API keys.
 *
 * @public
 */
export interface GeminiClient {
  readonly models: {
    generateContent(
      params: GeminiGenerateContentParameters,
    ): Promise<GeminiGenerateContentResponse>;
    generateContentStream?(
      params: GeminiGenerateContentParameters,
    ):
      | Promise<AsyncIterable<GeminiGenerateContentResponse>>
      | AsyncIterable<GeminiGenerateContentResponse>;
  };
}

/**
 * Minimal generateContent response fields this adapter reads.
 *
 * @public
 */
export interface GeminiGenerateContentResponse {
  readonly modelVersion?: string;
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: GeminiUsageMetadata | null;
  readonly promptFeedback?: GeminiPromptFeedback | null;
}

/**
 * @public
 */
export interface GeminiPromptFeedback {
  readonly blockReason?: string;
}

/**
 * @public
 */
export interface GeminiCandidate {
  readonly finishReason?: string | null;
  readonly content?: GeminiContent | null;
}

/**
 * @public
 */
export interface GeminiContent {
  readonly parts?: readonly GeminiPart[] | null;
}

/**
 * Alpha 1 reads `text` parts and skips `thought` parts.
 *
 * @public
 */
export interface GeminiPart {
  readonly text?: string;
  readonly thought?: boolean;
  readonly inlineData?: unknown;
  readonly functionCall?: unknown;
}

/**
 * Usage metadata field names follow `@google/genai`
 * `GenerateContentResponseUsageMetadata`.
 *
 * @public
 */
export interface GeminiUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly cachedContentTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly toolUsePromptTokenCount?: number;
}
