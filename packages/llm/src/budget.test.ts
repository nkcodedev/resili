import { describe, expect, it } from "vitest";

import { createMemoryBudgetAccountant, evaluateBudget, usdToMicroUsd } from "./index";

describe("evaluateBudget", () => {
  it("allows a request below the per-request limit", () => {
    expect(
      evaluateBudget({
        maxCostPerRequestMicroUsd: 100,
        estimatedCostMicroUsd: 99,
        accumulatedMicroUsd: 0,
      }),
    ).toEqual({ allowed: true });
  });

  it("allows a request exactly at the per-request limit", () => {
    expect(
      evaluateBudget({
        maxCostPerRequestMicroUsd: 100,
        estimatedCostMicroUsd: 100,
        accumulatedMicroUsd: 0,
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects a request above the per-request limit", () => {
    expect(
      evaluateBudget({
        maxCostPerRequestMicroUsd: 100,
        estimatedCostMicroUsd: 101,
        accumulatedMicroUsd: 0,
      }),
    ).toEqual({
      allowed: false,
      limitKind: "per-request",
      limitMicroUsd: 100,
    });
  });

  it("rejects when accumulated plus estimate would exceed the cap", () => {
    expect(
      evaluateBudget({
        maxAccumulatedCostMicroUsd: 200,
        estimatedCostMicroUsd: 50,
        accumulatedMicroUsd: 160,
      }),
    ).toEqual({
      allowed: false,
      limitKind: "accumulated",
      limitMicroUsd: 200,
    });
  });

  it("counts in-flight reservations against the accumulated cap", () => {
    expect(
      evaluateBudget({
        maxAccumulatedCostMicroUsd: 200,
        estimatedCostMicroUsd: 50,
        accumulatedMicroUsd: 100,
        reservedMicroUsd: 60,
      }),
    ).toEqual({
      allowed: false,
      limitKind: "accumulated",
      limitMicroUsd: 200,
    });
  });

  it("allows accumulated spend that lands exactly on the cap", () => {
    expect(
      evaluateBudget({
        maxAccumulatedCostMicroUsd: 200,
        estimatedCostMicroUsd: 40,
        accumulatedMicroUsd: 160,
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects a new request when the accumulated cap is already exhausted", () => {
    expect(
      evaluateBudget({
        maxAccumulatedCostMicroUsd: 200,
        estimatedCostMicroUsd: 0,
        accumulatedMicroUsd: 200,
      }),
    ).toEqual({
      allowed: false,
      limitKind: "accumulated",
      limitMicroUsd: 200,
    });
  });
});

describe("createMemoryBudgetAccountant", () => {
  it("commits actual spend through settle", () => {
    const accountant = createMemoryBudgetAccountant();

    expect(accountant.getAccumulatedMicroUsd("a")).toBe(0);
    expect(accountant.reserve("a", usdToMicroUsd(0.0001))).toBe(true);
    expect(accountant.getReservedMicroUsd("a")).toBe(100);
    expect(accountant.settle("a", 100, 100)).toBe(100);
    expect(accountant.settle("a", 0, 50)).toBe(150);
    expect(accountant.getReservedMicroUsd("a")).toBe(0);
    expect(accountant.getAccumulatedMicroUsd("b")).toBe(0);
  });

  it("rejects a second overlapping reservation against the accumulated cap", () => {
    const accountant = createMemoryBudgetAccountant();

    expect(accountant.reserve("s", 90, 100)).toBe(true);
    expect(accountant.reserve("s", 20, 100)).toBe(false);
    expect(accountant.getReservedMicroUsd("s")).toBe(90);
    expect(accountant.settle("s", 90, 90)).toBe(90);
    expect(accountant.reserve("s", 10, 100)).toBe(true);
  });
});
