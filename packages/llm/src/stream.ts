import {
  AbortError,
  RetryExceededError,
  TimeoutError,
  type Context,
  type MetricsRecorder,
} from "@resili/core";

import { markLlmStreamCommitted } from "./classifier";

import type { LlmFinishReason, LlmProviderStreamFrame, LlmRequest, LlmResponse } from "./contracts";
import { isLlmError, LlmError } from "./errors";
import type { LlmEventBus } from "./events";
import { recordLlmStreamMetrics } from "./metrics";
import { calculateCost, type LlmCost, type PricingResolver } from "./pricing";
import { freezeResponse, normalizeUsage } from "./provider";

/**
 * User-visible incremental text.
 *
 * @public
 */
export interface LlmStreamTextDelta {
  readonly type: "text-delta";
  readonly text: string;
}

/**
 * Terminal success payload yielded as the last stream event.
 *
 * @public
 */
export interface LlmStreamCompleted {
  readonly type: "completed";
  readonly provider: string;
  readonly model: string;
  readonly usage: LlmResponse["usage"];
  readonly finishReason: LlmFinishReason;
  readonly cost?: LlmCost;
}

/**
 * Public stream events. Failures reject the iterator instead of yielding an
 * error event.
 *
 * @public
 */
export type LlmStreamEvent = LlmStreamTextDelta | LlmStreamCompleted;

/**
 * Terminal success value of {@link LlmStream.result}.
 *
 * @public
 */
export interface LlmStreamResult {
  readonly provider: string;
  readonly model: string;
  readonly usage: LlmResponse["usage"];
  readonly finishReason: LlmFinishReason;
  readonly cost?: LlmCost;
}

/**
 * Pull-through LLM stream. Consumption keeps `@resili/core` `execute()` pending.
 *
 * `result()` does not start provider execution. Iterate the stream (or call
 * `next()`) so the pull-through pump can run. Multiple `result()` calls share
 * one terminal promise. Calling `result()` without consuming or cancelling
 * leaves that promise pending (with a no-op rejection handler so unused
 * `result()` does not warn). `iterator.return()` before the first `next()`
 * rejects `result()` with `AbortError`.
 *
 * Unsuccessful streams reject `result()` with the same error thrown by
 * iteration (provider failure, timeout, caller abort, or early `break`).
 * Concurrent `next()` calls are rejected.
 *
 * @public
 */
export interface LlmStream {
  [Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent, undefined>;
  result(): Promise<LlmStreamResult>;
}

/**
 * @internal
 */
export interface StreamRuntime {
  readonly execute: (
    operation: (ctx: Context) => Promise<LlmResponse>,
    init: StreamExecuteInit,
  ) => Promise<LlmResponse>;
  readonly stream: (
    request: LlmRequest,
    ctx: Context,
  ) => Promise<AsyncIterable<LlmProviderStreamFrame>>;
  readonly events: LlmEventBus;
  readonly metrics: MetricsRecorder;
  readonly pricing: PricingResolver | undefined;
  readonly request: LlmRequest;
  readonly requestId: string;
  readonly callerSignal: AbortSignal | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * @internal
 */
export interface StreamExecuteInit {
  readonly requestId: string;
  readonly operationName: string;
  readonly serviceName: string;
  readonly startedAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

interface Delivery {
  readonly resolve: (value: IteratorResult<LlmStreamEvent, undefined>) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * @internal
 */
export function createLlmStream(runtime: StreamRuntime): LlmStream {
  const abortController = new AbortController();
  let started = false;
  let closed = false;
  let consumerStopped = false;
  let completedDelivered = false;
  let committed = false;
  let chunkCount = 0;
  let firstTextAt: number | undefined;
  let demand: (() => void) | undefined;
  let cancelDemand: ((error: Error) => void) | undefined;
  let delivery: Delivery | undefined;
  let terminalError: Error | undefined;
  let completedResult: LlmStreamCompleted | undefined;
  let providerIterator: { return?: () => Promise<unknown> } | undefined;
  let settleTerminal: ((value: LlmStreamResult) => void) | undefined;
  let failTerminal: ((error: unknown) => void) | undefined;

  const terminal = new Promise<LlmStreamResult>((resolve, reject) => {
    settleTerminal = resolve;
    failTerminal = reject;
  });
  terminal.catch(() => {
    // Unused result() must not warn; callers still observe the same rejection.
  });

  const fail = (error: unknown): void => {
    if (closed) {
      return;
    }

    closed = true;
    const abortReason = error instanceof Error ? error : new AbortError();
    terminalError = abortReason;
    abortController.abort(abortReason);
    cancelDemand?.(abortReason);
    cancelDemand = undefined;
    demand = undefined;
    const waiting = delivery;
    delivery = undefined;
    waiting?.reject(abortReason);
    failTerminal?.(error);
  };

  const waitForDemand = async (signal: AbortSignal): Promise<void> => {
    if (delivery !== undefined) {
      return;
    }

    const combined = AbortSignal.any([signal, abortController.signal]);

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const reason: unknown = combined.reason ?? signal.reason;
        reject(reason instanceof Error ? reason : new AbortError());
      };

      if (combined.aborted) {
        onAbort();
        return;
      }

      demand = (): void => {
        combined.removeEventListener("abort", onAbort);
        cancelDemand = undefined;
        resolve();
      };
      cancelDemand = (error: Error): void => {
        combined.removeEventListener("abort", onAbort);
        demand = undefined;
        reject(error);
      };
      combined.addEventListener("abort", onAbort, { once: true });
    });
  };

  const deliver = (result: IteratorResult<LlmStreamEvent, undefined>): boolean => {
    const waiting = delivery;
    delivery = undefined;

    if (waiting === undefined) {
      return false;
    }

    waiting.resolve(result);
    return true;
  };

  const start = (): void => {
    if (started) {
      return;
    }

    started = true;
    const startedAt = Date.now();

    runtime.events.emit({
      type: "LlmStreamStarted",
      timestamp: startedAt,
      requestId: runtime.requestId,
      operationName: "llm.stream",
      provider: runtime.request.provider,
      model: runtime.request.model,
    });

    const signals: AbortSignal[] = [abortController.signal];

    if (runtime.callerSignal !== undefined) {
      signals.push(runtime.callerSignal);
    }

    const composed = AbortSignal.any(signals);

    void runtime
      .execute(
        (ctx) =>
          pump({
            ctx,
            runtime,
            waitForDemand,
            deliver,
            setInnerIterator: (iterator) => {
              providerIterator = iterator;
            },
            markCommitted: (): void => {
              committed = true;
              markLlmStreamCommitted(ctx);
            },
            isCommitted: (): boolean => committed,
            onText: (): void => {
              chunkCount += 1;
              firstTextAt ??= Date.now();
            },
            onSuccess: (completed): void => {
              completedDelivered = true;
              const durationMs = Date.now() - startedAt;
              const ttftMs = firstTextAt === undefined ? undefined : firstTextAt - startedAt;

              runtime.events.emit({
                type: "LlmStreamCompleted",
                timestamp: Date.now(),
                requestId: runtime.requestId,
                operationName: "llm.stream",
                provider: completed.provider,
                model: completed.model,
                durationMs,
                ...(ttftMs === undefined ? {} : { ttftMs }),
                chunkCount,
                inputTokens: completed.usage.inputTokens,
                outputTokens: completed.usage.outputTokens,
                totalTokens: completed.usage.totalTokens,
                ...(completed.cost === undefined
                  ? {}
                  : { costMicroUsd: completed.cost.totalCostMicroUsd }),
              });
              recordLlmStreamMetrics(runtime.metrics, {
                result: "success",
                durationMs,
                ...(ttftMs === undefined ? {} : { ttftMs }),
                chunkCount,
                outputTokens: completed.usage.outputTokens,
              });
              completedResult = completed;
            },
          }),
        {
          requestId: runtime.requestId,
          operationName: "llm.stream",
          serviceName: runtime.request.provider,
          startedAt,
          metadata: runtime.metadata,
          signal: composed,
        },
      )
      .then(() => {
        closed = true;
        if (completedResult !== undefined) {
          settleTerminal?.(toResult(completedResult));
        }
      })
      .catch((error: unknown) => {
        const durationMs = Date.now() - startedAt;
        const normalized = normalizeFinalError(error, runtime.request, committed);

        runtime.events.emit({
          type: "LlmStreamFailed",
          timestamp: Date.now(),
          requestId: runtime.requestId,
          operationName: "llm.stream",
          provider: runtime.request.provider,
          model: runtime.request.model,
          durationMs,
          classification: isLlmError(normalized) ? normalized.classification : "unknown",
          retryable: isLlmError(normalized) ? normalized.retryable : false,
          committed,
        });
        recordLlmStreamMetrics(runtime.metrics, { result: "failure", durationMs });
        fail(normalized);
      });
  };

  const iterator: AsyncIterator<LlmStreamEvent, undefined> = {
    async next() {
      if (consumerStopped) {
        return { done: true, value: undefined };
      }

      if (terminalError !== undefined) {
        throw terminalError instanceof Error ? terminalError : new AbortError();
      }

      if (completedDelivered) {
        return { done: true, value: undefined };
      }

      if (delivery !== undefined) {
        throw new LlmError("invalid_request", {
          message: "LlmStream does not support concurrent next() calls.",
          provider: runtime.request.provider,
          model: runtime.request.model,
          retryable: false,
        });
      }

      const pulled = new Promise<IteratorResult<LlmStreamEvent, undefined>>((resolve, reject) => {
        delivery = { resolve, reject };
      });
      start();
      demand?.();
      demand = undefined;
      return await pulled;
    },
    async return() {
      consumerStopped = true;
      const abort = new AbortError();

      if (!started) {
        fail(abort);
        return { done: true, value: undefined };
      }

      abortController.abort(abort);
      cancelDemand?.(abort);
      cancelDemand = undefined;
      demand = undefined;
      const waiting = delivery;
      delivery = undefined;
      waiting?.reject(abort);
      await closeIterator(providerIterator);
      providerIterator = undefined;
      return { done: true, value: undefined };
    },
    async throw(error?: unknown) {
      const thrown = error instanceof Error ? error : new LlmError("unknown", { cause: error });
      consumerStopped = true;

      if (!started) {
        fail(thrown);
        return { done: true, value: undefined };
      }

      abortController.abort(thrown);
      cancelDemand?.(thrown);
      cancelDemand = undefined;
      demand = undefined;
      const waiting = delivery;
      delivery = undefined;
      waiting?.reject(thrown);
      await closeIterator(providerIterator);
      providerIterator = undefined;
      return { done: true, value: undefined };
    },
  };

  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent, undefined> {
      return iterator;
    },
    result(): Promise<LlmStreamResult> {
      return terminal;
    },
  });
}

interface PumpInput {
  readonly ctx: Context;
  readonly runtime: StreamRuntime;
  readonly waitForDemand: (signal: AbortSignal) => Promise<void>;
  readonly deliver: (result: IteratorResult<LlmStreamEvent, undefined>) => boolean;
  readonly setInnerIterator: (iterator: { return?: () => Promise<unknown> } | undefined) => void;
  readonly markCommitted: () => void;
  readonly isCommitted: () => boolean;
  readonly onText: () => void;
  readonly onSuccess: (completed: LlmStreamCompleted) => void;
}

async function pump(input: PumpInput): Promise<LlmResponse> {
  const iterable = await input.runtime.stream(input.runtime.request, input.ctx);
  const iterator = iterable[Symbol.asyncIterator]();
  input.setInnerIterator(iterator);
  let model = input.runtime.request.model;
  let finishReason: LlmFinishReason = "unknown";
  let usagePartial: Partial<LlmResponse["usage"]> = {};

  try {
    while (!input.ctx.signal.aborted) {
      await input.waitForDemand(input.ctx.signal);

      const next = await iterator.next();

      if (next.done === true) {
        const usage = normalizeUsage(usagePartial);
        const response = freezeResponse({
          provider: input.runtime.request.provider,
          model,
          content: "",
          usage,
          finishReason,
        });
        const cost = resolveStreamCost(response, input.runtime.pricing);
        const completed: LlmStreamCompleted = Object.freeze({
          type: "completed",
          provider: response.provider,
          model: response.model,
          usage: response.usage,
          finishReason: response.finishReason,
          ...(cost === undefined ? {} : { cost }),
        });

        input.deliver({ value: completed, done: false });
        input.onSuccess(completed);
        return response;
      }

      const frame = next.value;

      if (typeof frame.model === "string" && frame.model.length > 0) {
        model = frame.model;
      }

      if (frame.finishReason !== undefined) {
        finishReason = frame.finishReason;
      }

      if (frame.usage !== undefined) {
        usagePartial = { ...usagePartial, ...frame.usage };
      }

      const text = frame.text;

      if (typeof text === "string" && text.length > 0) {
        const delivered = input.deliver({
          value: Object.freeze({ type: "text-delta", text }),
          done: false,
        });

        if (delivered) {
          input.markCommitted();
          input.onText();
        }
      }
    }

    throw toThrown(input.ctx.signal.reason ?? new AbortError());
  } catch (error) {
    throw toThrown(afterCommit(error, input.isCommitted(), input.runtime.request));
  } finally {
    await closeIterator(iterator);
    input.setInnerIterator(undefined);
  }
}

async function closeIterator(
  iterator: { return?: () => Promise<unknown> } | undefined,
): Promise<void> {
  if (iterator === undefined) {
    return;
  }
  try {
    await iterator.return?.();
  } catch {
    // Cleanup must not replace the primary stream error.
  }
}

function unwrapRetryExceeded(error: unknown): unknown {
  if (error instanceof RetryExceededError && error.lastError instanceof TimeoutError) {
    return error.lastError;
  }

  return error;
}

function afterCommit(error: unknown, committed: boolean, request: LlmRequest): unknown {
  if (!committed) {
    return error;
  }

  if (error instanceof TimeoutError) {
    return new LlmError("timeout", {
      retryable: false,
      cause: error,
      provider: request.provider,
      model: request.model,
    });
  }

  if (error instanceof AbortError) {
    return error;
  }

  if (isLlmError(error)) {
    return new LlmError(error.classification, {
      retryable: false,
      cause: error,
      provider: request.provider,
      model: request.model,
      message: error.message,
    });
  }

  return new LlmError("unknown", {
    retryable: false,
    cause: error,
    provider: request.provider,
    model: request.model,
  });
}

function toResult(completed: LlmStreamCompleted): LlmStreamResult {
  return Object.freeze({
    provider: completed.provider,
    model: completed.model,
    usage: completed.usage,
    finishReason: completed.finishReason,
    ...(completed.cost === undefined ? {} : { cost: completed.cost }),
  });
}

function resolveStreamCost(
  response: LlmResponse,
  pricing: PricingResolver | undefined,
): LlmCost | undefined {
  if (pricing === undefined) {
    return undefined;
  }

  const rate = pricing.resolve(response.provider, response.model);

  if (rate === undefined) {
    return undefined;
  }

  return calculateCost(response.usage, rate);
}

function toThrown(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new LlmError("unknown", { cause: error });
}

function normalizeFinalError(error: unknown, request: LlmRequest, committed: boolean): unknown {
  if (!committed) {
    return error;
  }

  return afterCommit(unwrapRetryExceeded(error), true, request);
}
