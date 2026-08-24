import { ConfigurationError, type Context } from "@resili/core";
import { defineProvider, type LlmProvider, type LlmRequest, type LlmResponse } from "@resili/llm";

import type { AnthropicClient, AnthropicContentBlock, AnthropicMessage } from "./anthropic-types";
import { mapAnthropicError } from "./errors";
import { mapFinishReason } from "./finish-reason";
import { mapUsage } from "./usage";

/**
 * Options for {@link createAnthropicProvider}.
 *
 * @public
 */
export interface CreateAnthropicProviderOptions {
  /**
   * User-owned Anthropic SDK client (or a structural mock).
   *
   * Resili never constructs this client and never reads `apiKey`.
   */
  readonly client: AnthropicClient;

  /**
   * Default model when `LlmRequest.model` is empty.
   */
  readonly model?: string;

  /**
   * Required Messages `max_tokens`. Anthropic requires this field; Resili does
   * not invent a default.
   */
  readonly maxTokens: number;
}

/**
 * SDK retry count forced on every Messages call so Resili owns retry.
 *
 * `@anthropic-ai/sdk` defaults to `maxRetries: 2`. Passing `0` here prevents
 * Anthropic SDK retries from multiplying Resili retry attempts.
 *
 * @public
 */
export const ANTHROPIC_SDK_MAX_RETRIES = 0;

/**
 * Creates an Anthropic Messages provider for `@resili/llm`.
 *
 * @public
 */
export function createAnthropicProvider(options: CreateAnthropicProviderOptions): LlmProvider {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("Anthropic provider options must be an object.", {
      field: "options",
    });
  }

  if (typeof options.client.messages.create !== "function") {
    throw new ConfigurationError("options.client must expose messages.create.", {
      field: "client",
    });
  }

  if (
    options.model !== undefined &&
    (typeof options.model !== "string" || options.model.trim().length === 0)
  ) {
    throw new ConfigurationError("options.model must be a non-empty string.", { field: "model" });
  }

  if (
    typeof options.maxTokens !== "number" ||
    !Number.isFinite(options.maxTokens) ||
    !Number.isInteger(options.maxTokens) ||
    options.maxTokens <= 0
  ) {
    throw new ConfigurationError("options.maxTokens must be a positive integer.", {
      field: "maxTokens",
    });
  }

  const defaultModel = options.model?.trim();
  const maxTokens = options.maxTokens;
  const client = options.client;

  return defineProvider({
    name: "anthropic",
    async execute(request: LlmRequest, ctx: Context): Promise<LlmResponse> {
      const model = resolveModel(request.model, defaultModel);

      try {
        const message = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: request.input }],
          },
          {
            signal: ctx.signal,
            maxRetries: ANTHROPIC_SDK_MAX_RETRIES,
          },
        );

        return normalizeMessage(message, model);
      } catch (error) {
        mapAnthropicError(error, model);
      }
    },
  });
}

function resolveModel(requestModel: string, defaultModel: string | undefined): string {
  const model = requestModel.trim() || defaultModel;

  if (model === undefined || model.length === 0) {
    throw new ConfigurationError(
      "A model is required on generate() or createAnthropicProvider().",
      {
        field: "model",
      },
    );
  }

  return model;
}

function normalizeMessage(message: AnthropicMessage, fallbackModel: string): LlmResponse {
  return Object.freeze({
    provider: "anthropic",
    model:
      typeof message.model === "string" && message.model.length > 0 ? message.model : fallbackModel,
    content: extractText(message.content),
    usage: mapUsage(message.usage),
    finishReason: mapFinishReason(message.stop_reason),
  });
}

function extractText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (content === undefined) {
    return "";
  }

  const parts: string[] = [];

  for (const block of content) {
    const text = textFromBlock(block);

    if (text !== undefined) {
      parts.push(text);
    }
  }

  return parts.join("");
}

function textFromBlock(block: AnthropicContentBlock): string | undefined {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }

  return undefined;
}
