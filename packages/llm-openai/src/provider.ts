import { ConfigurationError, type Context } from "@resili/core";
import {
  defineProvider,
  type LlmProvider,
  type LlmProviderStreamFrame,
  type LlmRequest,
  type LlmResponse,
} from "@resili/llm";

import { mapOpenAiError } from "./errors";
import { mapFinishReason } from "./finish-reason";
import type { OpenAiChatCompletion, OpenAiChatCompletionChunk, OpenAiClient } from "./openai-types";
import { mapStreamUsage, mapUsage } from "./usage";

/**
 * Options for {@link createOpenAiProvider}.
 *
 * @public
 */
export interface CreateOpenAiProviderOptions {
  /**
   * User-owned OpenAI SDK client (or a structural mock).
   *
   * Resili never constructs this client and never reads `apiKey`.
   */
  readonly client: OpenAiClient;

  /**
   * Default model when `LlmRequest.model` is empty.
   */
  readonly model?: string;
}

/**
 * SDK retry count forced on every Chat Completions call so Resili owns retry.
 *
 * The official `openai` client defaults to `maxRetries: 2`. Passing `0` here
 * prevents OpenAI SDK retries from multiplying Resili retry attempts.
 *
 * @public
 */
export const OPENAI_SDK_MAX_RETRIES = 0;

/**
 * Creates an OpenAI Chat Completions provider for `@resili/llm`.
 *
 * @public
 */
export function createOpenAiProvider(options: CreateOpenAiProviderOptions): LlmProvider {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("OpenAI provider options must be an object.", {
      field: "options",
    });
  }

  if (typeof options.client.chat.completions.create !== "function") {
    throw new ConfigurationError("options.client must expose chat.completions.create.", {
      field: "client",
    });
  }

  if (
    options.model !== undefined &&
    (typeof options.model !== "string" || options.model.trim().length === 0)
  ) {
    throw new ConfigurationError("options.model must be a non-empty string.", { field: "model" });
  }

  const defaultModel = options.model?.trim();
  const client = options.client;

  return defineProvider({
    name: "openai",
    async execute(request: LlmRequest, ctx: Context): Promise<LlmResponse> {
      const model = resolveModel(request.model, defaultModel);

      try {
        const completion = await client.chat.completions.create(
          {
            model,
            messages: [{ role: "user", content: request.input }],
          },
          {
            signal: ctx.signal,
            maxRetries: OPENAI_SDK_MAX_RETRIES,
          },
        );

        if (!isChatCompletion(completion)) {
          throw new ConfigurationError("OpenAI unary create() returned a stream.", {
            field: "client",
          });
        }

        return normalizeCompletion(completion, model);
      } catch (error) {
        if (error instanceof ConfigurationError) {
          throw error;
        }

        mapOpenAiError(error, model);
      }
    },
    async stream(
      request: LlmRequest,
      ctx: Context,
    ): Promise<AsyncIterable<LlmProviderStreamFrame>> {
      const model = resolveModel(request.model, defaultModel);

      try {
        const completion = await client.chat.completions.create(
          {
            model,
            messages: [{ role: "user", content: request.input }],
            stream: true,
            stream_options: { include_usage: true },
          },
          {
            signal: ctx.signal,
            maxRetries: OPENAI_SDK_MAX_RETRIES,
          },
        );

        if (isChatCompletion(completion)) {
          throw new ConfigurationError("OpenAI streaming create() returned a unary completion.", {
            field: "client",
          });
        }

        return mapOpenAiStream(completion, model);
      } catch (error) {
        if (error instanceof ConfigurationError) {
          throw error;
        }

        mapOpenAiError(error, model);
      }
    },
  });
}

function resolveModel(requestModel: string, defaultModel: string | undefined): string {
  const model = requestModel.trim() || defaultModel;

  if (model === undefined || model.length === 0) {
    throw new ConfigurationError("A model is required on generate() or createOpenAiProvider().", {
      field: "model",
    });
  }

  return model;
}

function normalizeCompletion(completion: OpenAiChatCompletion, fallbackModel: string): LlmResponse {
  const choice = completion.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = mapFinishReason(choice?.finish_reason);

  return Object.freeze({
    provider: "openai",
    model:
      typeof completion.model === "string" && completion.model.length > 0
        ? completion.model
        : fallbackModel,
    content: typeof content === "string" ? content : "",
    usage: mapUsage(completion.usage),
    finishReason,
  });
}

function isChatCompletion(
  value: OpenAiChatCompletion | AsyncIterable<OpenAiChatCompletionChunk>,
): value is OpenAiChatCompletion {
  return !(Symbol.asyncIterator in value);
}

function mapOpenAiStream(
  iterable: AsyncIterable<OpenAiChatCompletionChunk>,
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

            return { done: false, value: chunkToFrame(result.value, fallbackModel) };
          } catch (error) {
            mapOpenAiError(error, fallbackModel);
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

function chunkToFrame(
  chunk: OpenAiChatCompletionChunk,
  fallbackModel: string,
): LlmProviderStreamFrame {
  const choice = chunk.choices?.[0];
  const text = choice?.delta?.content;
  const finishReason =
    choice?.finish_reason === undefined || choice.finish_reason === null
      ? undefined
      : mapFinishReason(choice.finish_reason);
  const model =
    typeof chunk.model === "string" && chunk.model.length > 0 ? chunk.model : fallbackModel;
  const usage = chunk.usage;

  return {
    model,
    ...(typeof text === "string" ? { text } : {}),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined || usage === null ? {} : { usage: mapStreamUsage(usage) }),
  };
}
