import type { Labels, MetricsRecorder } from "@resili/core";
import { noopMetrics } from "@resili/core";

/**
 * Low-cardinality LLM metric names.
 *
 * Labels are limited to `result` (`success` | `failure` | `budget_rejected`).
 * Provider, model, prompt, user, and request id must never be used as labels.
 *
 * @public
 */
export const LLM_METRIC_NAMES = Object.freeze({
  requests: "resili_llm_requests_total",
  failures: "resili_llm_failures_total",
  budgetRejections: "resili_llm_budget_rejections_total",
  latencyMs: "resili_llm_latency_ms",
  inputTokens: "resili_llm_input_tokens_total",
  outputTokens: "resili_llm_output_tokens_total",
  tokens: "resili_llm_tokens_total",
  costMicroUsd: "resili_llm_cost_micro_usd_total",
  streams: "resili_llm_streams_total",
  streamFailures: "resili_llm_stream_failures_total",
  streamDurationMs: "resili_llm_stream_duration_ms",
  streamTtftMs: "resili_llm_stream_ttft_ms",
  streamChunks: "resili_llm_stream_chunks_total",
  streamOutputTokens: "resili_llm_stream_output_tokens_total",
});

/**
 * @internal
 */
export type LlmMetricResult = "success" | "failure" | "budget_rejected";

/**
 * @internal
 */
export function recordLlmMetrics(
  metrics: MetricsRecorder,
  input: {
    readonly result: LlmMetricResult;
    readonly durationMs: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly costMicroUsd?: number;
  },
): void {
  const labels: Labels = { result: input.result };

  try {
    metrics.counter(LLM_METRIC_NAMES.requests).add(1, labels);

    if (input.result === "failure") {
      metrics.counter(LLM_METRIC_NAMES.failures).add(1, labels);
    }

    if (input.result === "budget_rejected") {
      metrics.counter(LLM_METRIC_NAMES.budgetRejections).add(1, labels);
    }

    metrics.histogram(LLM_METRIC_NAMES.latencyMs).record(input.durationMs, labels);

    if (input.inputTokens !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.inputTokens).add(input.inputTokens, labels);
    }

    if (input.outputTokens !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.outputTokens).add(input.outputTokens, labels);
    }

    if (input.totalTokens !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.tokens).add(input.totalTokens, labels);
    }

    if (input.costMicroUsd !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.costMicroUsd).add(input.costMicroUsd, labels);
    }
  } catch {
    // Metrics backends must never break request execution.
  }
}

/**
 * @internal
 */
export function recordLlmStreamMetrics(
  metrics: MetricsRecorder,
  input: {
    readonly result: "success" | "failure";
    readonly durationMs: number;
    readonly ttftMs?: number;
    readonly chunkCount?: number;
    readonly outputTokens?: number;
  },
): void {
  const labels: Labels = { result: input.result };

  try {
    metrics.counter(LLM_METRIC_NAMES.streams).add(1, labels);

    if (input.result === "failure") {
      metrics.counter(LLM_METRIC_NAMES.streamFailures).add(1, labels);
    }

    metrics.histogram(LLM_METRIC_NAMES.streamDurationMs).record(input.durationMs, labels);

    if (input.ttftMs !== undefined) {
      metrics.histogram(LLM_METRIC_NAMES.streamTtftMs).record(input.ttftMs, labels);
    }

    if (input.chunkCount !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.streamChunks).add(input.chunkCount, labels);
    }

    if (input.outputTokens !== undefined) {
      metrics.counter(LLM_METRIC_NAMES.streamOutputTokens).add(input.outputTokens, labels);
    }
  } catch {
    // Metrics backends must never break request execution.
  }
}

/**
 * @internal
 */
export function resolveMetrics(metrics: MetricsRecorder | undefined): MetricsRecorder {
  return metrics ?? noopMetrics;
}
