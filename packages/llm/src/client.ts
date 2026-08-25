import { randomUUID } from "node:crypto";

import {
  ConfigurationError,
  createClient,
  type Client,
  type Context,
  type EventHandler,
  type MetricsRecorder,
  type ResiliConfig,
  type ResiliEventType,
  type Unsubscribe,
} from "@resili/core";

import {
  createBudgetPolicyFactory,
  LLM_REQUEST_METADATA_KEY,
  normalizeBudgetOptions,
  type BudgetGuardOptions,
} from "./budget";
import {
  createLlmStreamCommitState,
  LLM_STREAM_COMMIT_STATE_KEY,
  llmClassifier,
  withStreamCommitRetryGuard,
} from "./classifier";
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from "./contracts";
import { isLlmError, LlmError } from "./errors";
import {
  LlmEventBus,
  type LlmEventHandler,
  type LlmEventType,
  type LlmUnsubscribe,
} from "./events";
import { recordLlmMetrics, resolveMetrics } from "./metrics";
import { calculateCost, type LlmCost, type PricingResolver } from "./pricing";
import { freezeRequest, freezeResponse, normalizeUsage } from "./provider";
import { createLlmStream, type LlmStream } from "./stream";

/**
 * Generation input accepted by {@link LlmClient.generate}.
 *
 * @public
 */
export interface LlmGenerateRequest {
  readonly input: string;
  readonly model?: string;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * Generation result including normalized usage and optional cost.
 *
 * @public
 */
export interface LlmGenerateResult {
  readonly response: LlmResponse;
  readonly usage: LlmUsage;
  readonly cost?: LlmCost;
}

/**
 * Configuration for {@link createLlmClient}.
 *
 * LLM-specific fields are stripped before the remainder is passed to
 * {@link createClient}.
 *
 * @public
 */
export interface CreateLlmClientOptions extends ResiliConfig<LlmResponse> {
  readonly provider: LlmProvider;
  readonly model?: string;
  readonly pricing?: PricingResolver;
  readonly budget?: BudgetGuardOptions;
  readonly metrics?: MetricsRecorder;
}

/**
 * Provider-neutral LLM client.
 *
 * @public
 */
export interface LlmClient {
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
  stream(request: LlmGenerateRequest): LlmStream;
  on<T extends LlmEventType>(type: T, handler: LlmEventHandler<T>): LlmUnsubscribe;
  onCore<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  destroy(): Promise<void>;
}

/**
 * Creates a provider-neutral LLM client backed by `@resili/core`.
 *
 * @public
 */
export function createLlmClient(options: CreateLlmClientOptions): LlmClient {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("LLM client options must be an object.", { field: "options" });
  }

  if (typeof options.provider.execute !== "function") {
    throw new ConfigurationError("options.provider must be a defined LLM provider.", {
      field: "provider",
    });
  }

  if (
    options.model !== undefined &&
    (typeof options.model !== "string" || options.model.trim().length === 0)
  ) {
    throw new ConfigurationError("options.model must be a non-empty string.", { field: "model" });
  }

  const events = new LlmEventBus();
  const metrics = resolveMetrics(options.metrics);
  const defaultModel = options.model?.trim();
  const policies = [...(options.policies ?? [])];

  if (options.budget !== undefined) {
    const budgetOptions = normalizeBudgetOptions(options.budget);

    if (budgetOptions.onUnknownPricing === "reject" && options.pricing === undefined) {
      throw new ConfigurationError(
        'budget.onUnknownPricing is "reject" (the default), so createLlmClient requires pricing.',
        { field: "pricing" },
      );
    }

    policies.push({
      factory: createBudgetPolicyFactory({
        events,
        options: budgetOptions,
        ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
      }),
    });
  }

  const client: Client<readonly [], LlmResponse> = createClient<readonly [], LlmResponse>(
    (): Promise<LlmResponse> => {
      throw new ConfigurationError("LLM client bound operation must not be invoked.", {
        field: "operation",
      });
    },
    {
      ...createCoreConfig(options),
      policies,
      classifier: withStreamCommitRetryGuard(options.classifier ?? llmClassifier),
    },
  );

  return Object.freeze({
    generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
      return generateOnce({
        client,
        events,
        metrics,
        options,
        defaultModel,
        request,
      });
    },
    stream(request: LlmGenerateRequest): LlmStream {
      return streamOnce({
        client,
        events,
        metrics,
        options,
        defaultModel,
        request,
      });
    },
    on: events.on.bind(events),
    onCore: client.on.bind(client),
    destroy: async (): Promise<void> => {
      events.clear();
      await client.destroy();
    },
  });
}

interface GenerateOnceInput {
  readonly client: Client<readonly [], LlmResponse>;
  readonly events: LlmEventBus;
  readonly metrics: MetricsRecorder;
  readonly options: CreateLlmClientOptions;
  readonly defaultModel: string | undefined;
  readonly request: LlmGenerateRequest;
}

function streamOnce(input: GenerateOnceInput): LlmStream {
  if (typeof input.options.provider.stream !== "function") {
    throw new ConfigurationError(
      "This provider does not support streaming. Implement optional LlmProvider.stream or use generate().",
      { field: "provider.stream" },
    );
  }

  const requestId = randomUUID();
  const model = resolveModel(input.request.model, input.defaultModel);
  const normalizedRequest = freezeRequest(createNormalizedRequest(input, model));
  const streamFn = input.options.provider.stream.bind(input.options.provider);

  return createLlmStream({
    execute: (operation, init) => input.client.execute(operation, init),
    stream: (request, ctx) => streamFn(request, ctx),
    events: input.events,
    metrics: input.metrics,
    pricing: input.options.pricing,
    request: normalizedRequest,
    requestId,
    callerSignal: input.request.signal,
    metadata: {
      [LLM_REQUEST_METADATA_KEY]: normalizedRequest,
      [LLM_STREAM_COMMIT_STATE_KEY]: createLlmStreamCommitState(),
    },
  });
}

async function generateOnce(input: GenerateOnceInput): Promise<LlmGenerateResult> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const model = resolveModel(input.request.model, input.defaultModel);
  const normalizedRequest = freezeRequest(createNormalizedRequest(input, model));

  input.events.emit({
    type: "LlmRequestStarted",
    timestamp: startedAt,
    requestId,
    operationName: "llm.generate",
    provider: normalizedRequest.provider,
    model: normalizedRequest.model,
  });

  try {
    const response = freezeResponse(
      await input.client.execute(
        (ctx: Context) => input.options.provider.execute(normalizedRequest, ctx),
        {
          requestId,
          operationName: "llm.generate",
          serviceName: normalizedRequest.provider,
          startedAt,
          metadata: { [LLM_REQUEST_METADATA_KEY]: normalizedRequest },
          ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
        },
      ),
    );
    const usage = normalizeUsage(response.usage);
    const cost = resolveCost(response, usage, input.options.pricing);
    const durationMs = Date.now() - startedAt;

    emitUsageAndCompleted(input.events, requestId, response, usage, durationMs, cost);
    recordLlmMetrics(input.metrics, {
      result: "success",
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      ...(cost === undefined ? {} : { costMicroUsd: cost.totalCostMicroUsd }),
    });

    if (cost === undefined) {
      return Object.freeze({ response, usage });
    }

    return Object.freeze({ response, usage, cost });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const llmError = toEventError(error, normalizedRequest);
    const result = llmError.classification === "budget" ? "budget_rejected" : "failure";

    input.events.emit({
      type: "LlmRequestFailed",
      timestamp: Date.now(),
      requestId,
      operationName: "llm.generate",
      provider: normalizedRequest.provider,
      model: normalizedRequest.model,
      durationMs,
      classification: llmError.classification,
      retryable: llmError.retryable,
    });
    recordLlmMetrics(input.metrics, { result, durationMs });

    throw error;
  }
}

function createNormalizedRequest(input: GenerateOnceInput, model: string): LlmRequest {
  return {
    provider: input.options.provider.name,
    model,
    input: input.request.input,
    ...(input.request.estimatedInputTokens === undefined
      ? {}
      : { estimatedInputTokens: input.request.estimatedInputTokens }),
    ...(input.request.estimatedOutputTokens === undefined
      ? {}
      : { estimatedOutputTokens: input.request.estimatedOutputTokens }),
    ...(input.request.metadata === undefined ? {} : { metadata: input.request.metadata }),
  };
}

function emitUsageAndCompleted(
  events: LlmEventBus,
  requestId: string,
  response: LlmResponse,
  usage: LlmUsage,
  durationMs: number,
  cost: LlmCost | undefined,
): void {
  const costFields = cost === undefined ? {} : { costMicroUsd: cost.totalCostMicroUsd };
  const base = {
    timestamp: Date.now(),
    requestId,
    operationName: "llm.generate" as const,
    provider: response.provider,
    model: response.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...costFields,
  };

  events.emit({ type: "LlmUsageRecorded", ...base });
  events.emit({ type: "LlmRequestCompleted", durationMs, ...base });
}

function toEventError(error: unknown, request: LlmRequest): LlmError {
  if (isLlmError(error)) {
    return error;
  }

  return new LlmError("unknown", {
    cause: error,
    provider: request.provider,
    model: request.model,
  });
}

function resolveModel(requestModel: string | undefined, defaultModel: string | undefined): string {
  const requested = requestModel?.trim();
  const model = requested !== undefined && requested.length > 0 ? requested : defaultModel?.trim();

  if (model === undefined || model.length === 0) {
    throw new ConfigurationError("A model is required on generate() or createLlmClient().", {
      field: "model",
    });
  }

  return model;
}

function resolveCost(
  response: LlmResponse,
  usage: LlmUsage,
  pricing: PricingResolver | undefined,
): LlmCost | undefined {
  if (pricing === undefined) {
    return undefined;
  }

  const rate = pricing.resolve(response.provider, response.model);

  if (rate === undefined) {
    return undefined;
  }

  return calculateCost(usage, rate);
}

function createCoreConfig(options: CreateLlmClientOptions): ResiliConfig<LlmResponse> {
  const {
    provider: _provider,
    model: _model,
    pricing: _pricing,
    budget: _budget,
    metrics: _metrics,
    ...config
  } = options;

  void _provider;
  void _model;
  void _pricing;
  void _budget;
  void _metrics;

  return config;
}
