import { ConfigurationError, type Context } from "@resili/core";
import { defineProvider, type LlmProvider, type LlmRequest, type LlmResponse } from "@resili/llm";

import { mapGeminiError } from "./errors";
import { mapFinishReason } from "./finish-reason";
import type {
  GeminiClient,
  GeminiContent,
  GeminiGenerateContentResponse,
  GeminiPart,
} from "./gemini-types";
import { mapUsage } from "./usage";

/**
 * Options for {@link createGeminiProvider}.
 *
 * @public
 */
export interface CreateGeminiProviderOptions {
  /**
   * User-owned `@google/genai` client (or a structural mock).
   *
   * Resili never constructs this client and never reads `apiKey`.
   */
  readonly client: GeminiClient;

  /**
   * Default model when `LlmRequest.model` is empty.
   */
  readonly model?: string;
}

/**
 * Value for `GenerateContentConfig.httpOptions.retryOptions.attempts`.
 *
 * Inspected against `@google/genai@2.18.0`: `attempts` includes the original
 * request. `0` or `1` means no retries. The SDK default is `5`. Passing `1`
 * keeps a single HTTP attempt so Resili owns retry.
 *
 * @public
 */
export const GEMINI_SDK_HTTP_ATTEMPTS = 1;

/**
 * Creates a Gemini `generateContent` provider for `@resili/llm`.
 *
 * @public
 */
export function createGeminiProvider(options: CreateGeminiProviderOptions): LlmProvider {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("Gemini provider options must be an object.", {
      field: "options",
    });
  }

  if (typeof options.client.models.generateContent !== "function") {
    throw new ConfigurationError("options.client must expose models.generateContent.", {
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
    name: "gemini",
    async execute(request: LlmRequest, ctx: Context): Promise<LlmResponse> {
      const model = resolveModel(request.model, defaultModel);

      try {
        const response = await client.models.generateContent({
          model,
          contents: request.input,
          config: {
            abortSignal: ctx.signal,
            httpOptions: {
              retryOptions: {
                attempts: GEMINI_SDK_HTTP_ATTEMPTS,
              },
            },
          },
        });

        return normalizeResponse(response, model);
      } catch (error) {
        mapGeminiError(error, model);
      }
    },
  });
}

function resolveModel(requestModel: string, defaultModel: string | undefined): string {
  const model = requestModel.trim() || defaultModel;

  if (model === undefined || model.length === 0) {
    throw new ConfigurationError("A model is required on generate() or createGeminiProvider().", {
      field: "model",
    });
  }

  return model;
}

function normalizeResponse(
  response: GeminiGenerateContentResponse,
  fallbackModel: string,
): LlmResponse {
  const candidate = response.candidates?.[0];
  const blockReason = response.promptFeedback?.blockReason;
  const finishReason =
    blockReason !== undefined && blockReason.length > 0 && candidate === undefined
      ? mapFinishReason("SAFETY")
      : mapFinishReason(candidate?.finishReason);

  const modelVersion = response.modelVersion;

  return Object.freeze({
    provider: "gemini",
    model:
      typeof modelVersion === "string" && modelVersion.length > 0 ? modelVersion : fallbackModel,
    content: extractText(candidate?.content),
    usage: mapUsage(response.usageMetadata),
    finishReason,
  });
}

function extractText(content: GeminiContent | null | undefined): string {
  const partsList = content?.parts;

  if (partsList === undefined || partsList === null) {
    return "";
  }

  const parts: string[] = [];

  for (const part of partsList) {
    const text = textFromPart(part);

    if (text !== undefined) {
      parts.push(text);
    }
  }

  return parts.join("");
}

function textFromPart(part: GeminiPart): string | undefined {
  if (part.thought === true) {
    return undefined;
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  return undefined;
}
