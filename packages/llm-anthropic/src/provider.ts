import { ConfigurationError, type Context } from "@resili/core";
import {
  defineProvider,
  type LlmProvider,
  type LlmProviderStreamFrame,
  type LlmRequest,
  type LlmResponse,
} from "@resili/llm";

import type {
  AnthropicClient,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicStreamEvent,
} from "./anthropic-types";
import { mapAnthropicError } from "./errors";
import { mapFinishReason } from "./finish-reason";
import { mapStreamUsage, mapUsage } from "./usage";

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

        if (!isAnthropicMessage(message)) {
          throw new ConfigurationError("Anthropic unary create() returned a stream.", {
            field: "client",
          });
        }

        return normalizeMessage(message, model);
      } catch (error) {
        if (error instanceof ConfigurationError) {
          throw error;
        }

        mapAnthropicError(error, model);
      }
    },
    async stream(
      request: LlmRequest,
      ctx: Context,
    ): Promise<AsyncIterable<LlmProviderStreamFrame>> {
      const model = resolveModel(request.model, defaultModel);

      try {
        const created = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: request.input }],
            stream: true,
          },
          {
            signal: ctx.signal,
            maxRetries: ANTHROPIC_SDK_MAX_RETRIES,
          },
        );

        if (isAnthropicMessage(created)) {
          throw new ConfigurationError("Anthropic streaming create() returned a unary message.", {
            field: "client",
          });
        }

        return mapAnthropicStream(created, model);
      } catch (error) {
        if (error instanceof ConfigurationError) {
          throw error;
        }

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

function isAnthropicMessage(
  value: AnthropicMessage | AsyncIterable<AnthropicStreamEvent>,
): value is AnthropicMessage {
  return !(Symbol.asyncIterator in value);
}

function mapAnthropicStream(
  iterable: AsyncIterable<AnthropicStreamEvent>,
  fallbackModel: string,
): AsyncIterable<LlmProviderStreamFrame> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmProviderStreamFrame> {
      const inner = iterable[Symbol.asyncIterator]();

      return {
        async next(): Promise<IteratorResult<LlmProviderStreamFrame>> {
          try {
            const result = await inner.next();

            if (result.done === true) {
              return result;
            }

            return { done: false, value: eventToFrame(result.value, fallbackModel) };
          } catch (error) {
            mapAnthropicError(error, fallbackModel);
          }
        },
        async return(): Promise<IteratorResult<LlmProviderStreamFrame>> {
          try {
            await inner.return?.();
          } catch {
            // Cleanup errors must not replace the primary stream error.
          }

          return { done: true, value: undefined };
        },
      };
    },
  };
}

function eventToFrame(event: AnthropicStreamEvent, fallbackModel: string): LlmProviderStreamFrame {
  if (event.type === "message_start") {
    const model = event.message?.model;
    const usage = event.message?.usage;

    return {
      ...(typeof model === "string" && model.length > 0 ? { model } : { model: fallbackModel }),
      ...(usage === undefined || usage === null ? {} : { usage: mapStreamUsage(usage) }),
    };
  }

  if (event.type === "content_block_delta") {
    const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.text;

    return typeof text === "string" ? { text } : {};
  }

  if (event.type === "message_delta") {
    const stopReason = event.delta?.stop_reason;
    const usage = event.usage;

    return {
      ...(stopReason === undefined || stopReason === null
        ? {}
        : { finishReason: mapFinishReason(stopReason) }),
      ...(usage === undefined || usage === null ? {} : { usage: mapStreamUsage(usage) }),
    };
  }

  return {};
}
