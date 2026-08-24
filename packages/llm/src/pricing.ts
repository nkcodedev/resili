import { ConfigurationError } from "@resili/core";

import type { LlmUsage } from "./contracts";
import { normalizeUsage } from "./provider";

/**
 * Integer scale used for deterministic USD accounting.
 *
 * 1 USD = {@link USD_MICROS} micro-USD. Public `*Usd` configuration fields are
 * converted with banker's-neutral round-half-up into this integer space before
 * any multiplication.
 *
 * @public
 */
export const USD_MICROS = 1_000_000;

/**
 * Token batch size matching "price per million tokens" configuration.
 *
 * @public
 */
export const TOKENS_PER_MILLION = 1_000_000;

/**
 * Immutable price row for one provider/model pair.
 *
 * Prices are USD per 1,000,000 tokens. They are never hard-coded by Resili.
 *
 * @public
 */
export interface ModelPricing {
  readonly provider: string;
  readonly model: string;
  readonly inputPerMillionTokensUsd: number;
  readonly outputPerMillionTokensUsd: number;
}

/**
 * Resolved integer rates used for calculation.
 *
 * @public
 */
export interface PricingRate {
  readonly provider: string;
  readonly model: string;
  readonly inputMicroUsdPerMillionTokens: number;
  readonly outputMicroUsdPerMillionTokens: number;
}

/**
 * Looks up {@link PricingRate} for a provider/model pair.
 *
 * @public
 */
export interface PricingResolver {
  resolve(provider: string, model: string): PricingRate | undefined;
}

/**
 * Deterministic cost for one request.
 *
 * `*Usd` fields are `microUsd / 1_000_000` and exist for display. Comparisons
 * and budgets must use `*MicroUsd`.
 *
 * @public
 */
export interface LlmCost {
  readonly provider: string;
  readonly model: string;
  readonly inputCostMicroUsd: number;
  readonly outputCostMicroUsd: number;
  readonly totalCostMicroUsd: number;
  readonly inputCostUsd: number;
  readonly outputCostUsd: number;
  readonly totalCostUsd: number;
  readonly currency: "USD";
}

/**
 * Converts a USD amount to integer micro-USD with round-half-up.
 *
 * @public
 */
export function usdToMicroUsd(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new ConfigurationError("USD amount must be a finite number >= 0.", { field: "usd" });
  }

  return roundHalfUp(usd * USD_MICROS);
}

/**
 * Converts integer micro-USD to USD.
 *
 * @public
 */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / USD_MICROS;
}

/**
 * Creates an in-memory pricing table resolver.
 *
 * Duplicate provider+model rows are rejected. Unknown models resolve to
 * `undefined` so callers can fail closed when a budget is configured.
 *
 * @public
 */
export function createPricingResolver(rows: readonly ModelPricing[]): PricingResolver {
  const table: unknown = rows;

  if (!Array.isArray(table)) {
    throw new ConfigurationError("Pricing table must be an array.", { field: "pricing" });
  }

  const rates = new Map<string, PricingRate>();

  for (const [index, row] of table.entries()) {
    const rate = normalizePricingRow(row, index);
    const key = pricingKey(rate.provider, rate.model);

    if (rates.has(key)) {
      throw new ConfigurationError(
        `Duplicate pricing row for provider "${rate.provider}" model "${rate.model}".`,
        { field: "pricing" },
      );
    }

    rates.set(key, rate);
  }

  return Object.freeze({
    resolve(provider: string, model: string): PricingRate | undefined {
      return rates.get(pricingKey(provider, model));
    },
  });
}

/**
 * Calculates request cost from normalized usage and a resolved rate.
 *
 * Cost for a token channel is:
 * `round_half_up(tokens * microUsdPerMillionTokens / 1_000_000)`.
 *
 * @public
 */
export function calculateCost(usage: LlmUsage, rate: PricingRate): LlmCost {
  const normalized = normalizeUsage(usage);
  const inputCostMicroUsd = tokenCostMicroUsd(
    normalized.inputTokens,
    rate.inputMicroUsdPerMillionTokens,
  );
  const outputCostMicroUsd = tokenCostMicroUsd(
    normalized.outputTokens,
    rate.outputMicroUsdPerMillionTokens,
  );
  const totalCostMicroUsd = inputCostMicroUsd + outputCostMicroUsd;

  return Object.freeze({
    provider: rate.provider,
    model: rate.model,
    inputCostMicroUsd,
    outputCostMicroUsd,
    totalCostMicroUsd,
    inputCostUsd: microUsdToUsd(inputCostMicroUsd),
    outputCostUsd: microUsdToUsd(outputCostMicroUsd),
    totalCostUsd: microUsdToUsd(totalCostMicroUsd),
    currency: "USD",
  });
}

/**
 * @internal
 */
export function tokenCostMicroUsd(tokens: number, microUsdPerMillionTokens: number): number {
  if (tokens === 0 || microUsdPerMillionTokens === 0) {
    return 0;
  }

  return divRoundHalfUp(tokens * microUsdPerMillionTokens, TOKENS_PER_MILLION);
}

/**
 * @internal
 */
export function pricingKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function normalizePricingRow(row: unknown, index: number): PricingRate {
  if (row === null || typeof row !== "object") {
    throw new ConfigurationError(`Pricing row ${String(index)} must be an object.`, {
      field: "pricing",
    });
  }

  const candidate = row as Partial<ModelPricing>;

  if (typeof candidate.provider !== "string" || candidate.provider.trim().length === 0) {
    throw new ConfigurationError("pricing.provider must be a non-empty string.", {
      field: "pricing.provider",
    });
  }

  if (typeof candidate.model !== "string" || candidate.model.trim().length === 0) {
    throw new ConfigurationError("pricing.model must be a non-empty string.", {
      field: "pricing.model",
    });
  }

  return Object.freeze({
    provider: candidate.provider.trim(),
    model: candidate.model.trim(),
    inputMicroUsdPerMillionTokens: usdToMicroUsd(candidate.inputPerMillionTokensUsd ?? Number.NaN),
    outputMicroUsdPerMillionTokens: usdToMicroUsd(
      candidate.outputPerMillionTokensUsd ?? Number.NaN,
    ),
  });
}

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

function divRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}
