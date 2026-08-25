import { ConfigurationError } from "@resili/core";

import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from "./contracts";

/**
 * Creates an immutable provider adapter.
 *
 * @public
 */
export function defineProvider(provider: LlmProvider): LlmProvider {
  const candidate: unknown = provider;

  if (candidate === null || typeof candidate !== "object") {
    throw new ConfigurationError("LLM provider must be an object.", { field: "provider" });
  }

  if (typeof provider.name !== "string" || provider.name.trim().length === 0) {
    throw new ConfigurationError("provider.name must be a non-empty string.", {
      field: "provider.name",
    });
  }

  if (typeof provider.execute !== "function") {
    throw new ConfigurationError("provider.execute must be a function.", {
      field: "provider.execute",
    });
  }

  if (typeof provider.stream === "function") {
    return Object.freeze({
      name: provider.name.trim(),
      execute: provider.execute.bind(provider),
      stream: provider.stream.bind(provider),
    });
  }

  return Object.freeze({
    name: provider.name.trim(),
    execute: provider.execute.bind(provider),
  });
}

/**
 * Normalizes usage so missing or non-finite counts become zero.
 *
 * @public
 */
export function normalizeUsage(usage: Partial<LlmUsage> | undefined): LlmUsage {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  const reportedTotal = usage?.totalTokens;
  const totalTokens =
    reportedTotal === undefined ? inputTokens + outputTokens : normalizeTokenCount(reportedTotal);
  const dimensions = normalizeDimensions(usage?.dimensions);

  if (dimensions === undefined) {
    return Object.freeze({
      inputTokens,
      outputTokens,
      totalTokens,
    });
  }

  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
    dimensions,
  });
}

/**
 * @internal
 */
export function normalizeTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}

function normalizeDimensions(
  dimensions: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (dimensions === undefined) {
    return undefined;
  }

  const entries = Object.entries(dimensions).filter(([, value]) => {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });

  if (entries.length === 0) {
    return undefined;
  }

  return Object.freeze(Object.fromEntries(entries.map(([key, value]) => [key, Math.trunc(value)])));
}

/**
 * @internal
 */
export function freezeRequest(request: LlmRequest): LlmRequest {
  if (request.metadata === undefined) {
    return Object.freeze({ ...request });
  }

  return Object.freeze({
    ...request,
    metadata: Object.freeze({ ...request.metadata }),
  });
}

/**
 * @internal
 */
export function freezeResponse(response: LlmResponse): LlmResponse {
  return Object.freeze({
    ...response,
    usage: normalizeUsage(response.usage),
  });
}
