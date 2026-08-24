import { ConfigurationError } from "@resili/core";
import { describe, expect, it } from "vitest";

import { calculateCost, createPricingResolver, microUsdToUsd, usdToMicroUsd } from "./pricing";

const RATE = {
  provider: "example",
  model: "model-a",
  inputPerMillionTokensUsd: 1,
  outputPerMillionTokensUsd: 5,
};

describe("createPricingResolver", () => {
  it("resolves known models and returns undefined for unknown models", () => {
    const pricing = createPricingResolver([RATE]);

    expect(pricing.resolve("example", "model-a")?.inputMicroUsdPerMillionTokens).toBe(
      usdToMicroUsd(1),
    );
    expect(pricing.resolve("example", "missing")).toBeUndefined();
  });

  it("rejects duplicate rows", () => {
    expect(() => createPricingResolver([RATE, RATE])).toThrow(ConfigurationError);
  });
});

describe("usdToMicroUsd", () => {
  it("round-half-up converts USD into integer micro-USD", () => {
    expect(usdToMicroUsd(1)).toBe(1_000_000);
    expect(usdToMicroUsd(0.0000004)).toBe(0);
    expect(usdToMicroUsd(0.0000005)).toBe(1);
  });
});

describe("calculateCost", () => {
  const pricing = createPricingResolver([RATE]);
  const rate = pricing.resolve("example", "model-a");

  if (rate === undefined) {
    throw new Error("expected rate");
  }

  it("calculates input, output, and combined cost", () => {
    const cost = calculateCost({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, rate);

    expect(cost.inputCostMicroUsd).toBe(100);
    expect(cost.outputCostMicroUsd).toBe(250);
    expect(cost.totalCostMicroUsd).toBe(350);
    expect(cost.inputCostUsd).toBe(microUsdToUsd(100));
    expect(cost.outputCostUsd).toBe(microUsdToUsd(250));
    expect(cost.totalCostUsd).toBe(microUsdToUsd(350));
    expect(cost.currency).toBe("USD");
  });

  it("returns zero cost for zero tokens", () => {
    const cost = calculateCost({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, rate);

    expect(cost.totalCostMicroUsd).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
  });

  it("uses deterministic round-half-up for token cost", () => {
    const fractional = createPricingResolver([
      {
        provider: "example",
        model: "model-b",
        inputPerMillionTokensUsd: 0.000003,
        outputPerMillionTokensUsd: 0,
      },
    ]).resolve("example", "model-b");

    if (fractional === undefined) {
      throw new Error("expected rate");
    }

    expect(
      calculateCost({ inputTokens: 499_999, outputTokens: 0, totalTokens: 499_999 }, fractional)
        .inputCostMicroUsd,
    ).toBe(1);
    expect(
      calculateCost({ inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }, fractional)
        .inputCostMicroUsd,
    ).toBe(2);
  });
});
