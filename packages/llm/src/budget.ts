import { ConfigurationError, definePolicy, type Context, type Next } from "@resili/core";

import type { LlmRequest, LlmResponse } from "./contracts";
import { LlmBudgetExceededError } from "./errors";
import type { LlmEventBus } from "./events";
import {
  calculateCost,
  type LlmCost,
  type PricingResolver,
  tokenCostMicroUsd,
  usdToMicroUsd,
} from "./pricing";
import { normalizeTokenCount, normalizeUsage } from "./provider";

/**
 * Internal metadata key used to pass the normalized request through Context.
 *
 * @internal
 */
export const LLM_REQUEST_METADATA_KEY = "resili.llm.request";

/**
 * Resolves a budget partition key.
 *
 * Encode tenant, user, day, or month into the returned string to approximate
 * those limits. Distributed stores are out of scope for this milestone.
 *
 * @public
 */
export type BudgetScopeResolver = (request: LlmRequest, ctx: Context) => string;

/**
 * Behavior when a price row cannot be resolved for the request's provider/model.
 *
 * - `"reject"` (default when Budget Guard is enabled): fail closed. Unknown
 *   price is never treated as `$0`.
 * - `"allow"`: skip cost preflight and cost accounting for that request.
 *   This is explicit fail-open.
 *
 * @public
 */
export type UnknownPricingBehavior = "allow" | "reject";

/**
 * Which Budget Guard limit rejected a request.
 *
 * @public
 */
export type BudgetLimitKind = "per-request" | "accumulated" | "unknown-pricing";

/**
 * Budget Guard configuration.
 *
 * Preflight uses **estimated** tokens (`estimatedInputTokens` /
 * `estimatedOutputTokens`). Actual output tokens are not known until the
 * provider returns, so `maxCostPerRequestUsd` is not a hard ceiling on actual
 * spend. Actual usage is recorded after execution and may exceed the estimate.
 *
 * @public
 */
export interface BudgetGuardOptions {
  /**
   * Maximum **estimated** cost allowed for a single request.
   *
   * Compared only to preflight estimates. Actual cost can be higher if output
   * tokens exceed `estimatedOutputTokens` or estimates are omitted.
   */
  readonly maxCostPerRequestUsd?: number;

  /**
   * Maximum accumulated **recorded** cost for a scope, plus in-flight
   * reservations of estimated cost.
   */
  readonly maxAccumulatedCostUsd?: number;

  /**
   * Static scope key or resolver. Defaults to `provider`.
   */
  readonly scope?: string | BudgetScopeResolver;

  /**
   * Emit a warning when accumulated spend reaches this fraction of
   * `maxAccumulatedCostUsd`. Defaults to `0.8`.
   */
  readonly warningThresholdRatio?: number;

  /**
   * What to do when pricing cannot be resolved. Defaults to `"reject"`.
   */
  readonly onUnknownPricing?: UnknownPricingBehavior;

  /**
   * Optional injectable ledger. Defaults to a process-local in-memory map.
   *
   * `reserve` / `settle` must be safe for concurrent callers in one process.
   * Synchronous mutation is sufficient on the JavaScript event loop.
   */
  readonly accountant?: BudgetAccountant;
}

/**
 * Spend ledger used by Budget Guard.
 *
 * Separate from admission so Redis or database implementations can be added
 * later without changing the decision function.
 *
 * @public
 */
export interface BudgetAccountant {
  /**
   * Committed spend for the scope, excluding in-flight reservations.
   */
  getAccumulatedMicroUsd(scope: string): number;

  /**
   * In-flight estimated spend reserved for the scope.
   */
  getReservedMicroUsd(scope: string): number;

  /**
   * Synchronously reserve estimated micro-USD against the accumulated cap.
   *
   * Returns false when `accumulated + reserved + estimated` would exceed
   * `maxAccumulatedMicroUsd`. When the cap is omitted, always reserves.
   */
  reserve(scope: string, estimatedMicroUsd: number, maxAccumulatedMicroUsd?: number): boolean;

  /**
   * Release a reservation and commit actual spend.
   *
   * Pass `actualMicroUsd = 0` to drop a reservation after a failed attempt.
   */
  settle(scope: string, reservedMicroUsd: number, actualMicroUsd: number): number;
}

/**
 * Pure budget decision input.
 *
 * `estimatedCostMicroUsd` must be a **known** estimate. Callers must not pass
 * `0` as a stand-in for unknown pricing.
 *
 * @public
 */
export interface BudgetDecisionInput {
  readonly maxCostPerRequestMicroUsd?: number;
  readonly maxAccumulatedCostMicroUsd?: number;
  readonly estimatedCostMicroUsd: number;
  readonly accumulatedMicroUsd: number;
  readonly reservedMicroUsd?: number;
}

/**
 * Pure budget decision.
 *
 * @public
 */
export type BudgetDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly limitKind: "per-request" | "accumulated";
      readonly limitMicroUsd: number;
    };

/**
 * Creates a process-local in-memory budget ledger.
 *
 * `reserve` and `settle` are synchronous so concurrent `generate()` calls on
 * the same event loop cannot both admit overlapping estimated spend against
 * `maxAccumulatedCostUsd`. This is not a distributed lock.
 *
 * @public
 */
export function createMemoryBudgetAccountant(): BudgetAccountant {
  const committed = new Map<string, number>();
  const reserved = new Map<string, number>();

  return Object.freeze({
    getAccumulatedMicroUsd(scope: string): number {
      return committed.get(scope) ?? 0;
    },
    getReservedMicroUsd(scope: string): number {
      return reserved.get(scope) ?? 0;
    },
    reserve(scope: string, estimatedMicroUsd: number, maxAccumulatedMicroUsd?: number): boolean {
      const accumulatedMicroUsd = committed.get(scope) ?? 0;
      const reservedMicroUsd = reserved.get(scope) ?? 0;
      const decision = evaluateBudget({
        estimatedCostMicroUsd: estimatedMicroUsd,
        accumulatedMicroUsd,
        reservedMicroUsd,
        ...(maxAccumulatedMicroUsd === undefined
          ? {}
          : { maxAccumulatedCostMicroUsd: maxAccumulatedMicroUsd }),
      });

      if (!decision.allowed) {
        return false;
      }

      reserved.set(scope, reservedMicroUsd + estimatedMicroUsd);

      return true;
    },
    settle(scope: string, reservedMicroUsd: number, actualMicroUsd: number): number {
      const nextReserved = Math.max(0, (reserved.get(scope) ?? 0) - reservedMicroUsd);
      if (nextReserved === 0) {
        reserved.delete(scope);
      } else {
        reserved.set(scope, nextReserved);
      }

      const nextCommitted = (committed.get(scope) ?? 0) + actualMicroUsd;
      committed.set(scope, nextCommitted);

      return nextCommitted;
    },
  });
}

/**
 * Decides whether a request may proceed from known numeric estimates.
 *
 * Limits are inclusive: estimated cost equal to the remaining budget is allowed.
 * In-flight `reservedMicroUsd` counts against the accumulated cap.
 *
 * @public
 */
export function evaluateBudget(input: BudgetDecisionInput): BudgetDecision {
  if (
    input.maxCostPerRequestMicroUsd !== undefined &&
    input.estimatedCostMicroUsd > input.maxCostPerRequestMicroUsd
  ) {
    return {
      allowed: false,
      limitKind: "per-request",
      limitMicroUsd: input.maxCostPerRequestMicroUsd,
    };
  }

  if (input.maxAccumulatedCostMicroUsd !== undefined) {
    const reservedMicroUsd = input.reservedMicroUsd ?? 0;
    const occupiedMicroUsd = input.accumulatedMicroUsd + reservedMicroUsd;
    const remaining = input.maxAccumulatedCostMicroUsd - occupiedMicroUsd;

    if (remaining < 0 || (remaining === 0 && input.estimatedCostMicroUsd === 0)) {
      return {
        allowed: false,
        limitKind: "accumulated",
        limitMicroUsd: input.maxAccumulatedCostMicroUsd,
      };
    }

    if (occupiedMicroUsd + input.estimatedCostMicroUsd > input.maxAccumulatedCostMicroUsd) {
      return {
        allowed: false,
        limitKind: "accumulated",
        limitMicroUsd: input.maxAccumulatedCostMicroUsd,
      };
    }
  }

  return { allowed: true };
}

/**
 * @internal
 */
export interface BudgetPolicyRuntime {
  readonly events: LlmEventBus;
  readonly pricing?: PricingResolver;
  readonly options: NormalizedBudgetOptions;
}

/**
 * @internal
 */
export interface NormalizedBudgetOptions {
  readonly maxCostPerRequestMicroUsd?: number;
  readonly maxAccumulatedCostMicroUsd?: number;
  readonly scope?: string | BudgetScopeResolver;
  readonly warningThresholdRatio: number;
  readonly onUnknownPricing: UnknownPricingBehavior;
  readonly accountant: BudgetAccountant;
}

/**
 * Place Budget Guard after cache and before retry.
 *
 * `{ after: "cache" }` cannot be used: `@resili/core` lists `"cache"` on
 * `PolicyOrder` but `isBuiltinPolicyAnchor` omits it, so `definePolicy`
 * throws `ConfigurationError`. `{ before: "retry" }` resolves to `199.5`,
 * which sits between cache (`150`) and retry (`200`) on the current pipeline.
 *
 * @internal
 */
export const BUDGET_POLICY_ORDER = Object.freeze({ before: "retry" as const });

/**
 * @internal
 */
export function createBudgetPolicyFactory(runtime: BudgetPolicyRuntime) {
  return definePolicy({
    name: "llm-budget",
    order: BUDGET_POLICY_ORDER,
    create() {
      return {
        name: "llm-budget",
        order: BUDGET_POLICY_ORDER,
        async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
          const request = getRequest(ctx);
          const scope = resolveScope(runtime.options.scope, request, ctx);
          const estimate = estimateCost(request, runtime.pricing);

          if (estimate.status === "unknown") {
            if (runtime.options.onUnknownPricing === "reject") {
              rejectBudget(runtime, ctx, request, scope, {
                allowed: false,
                limitKind: "unknown-pricing",
                limitMicroUsd: 0,
              });
            }

            return await next(ctx);
          }

          const accumulatedMicroUsd = runtime.options.accountant.getAccumulatedMicroUsd(scope);
          const reservedMicroUsd = runtime.options.accountant.getReservedMicroUsd(scope);
          const decision = evaluateBudget({
            estimatedCostMicroUsd: estimate.costMicroUsd,
            accumulatedMicroUsd,
            reservedMicroUsd,
            ...(runtime.options.maxCostPerRequestMicroUsd === undefined
              ? {}
              : { maxCostPerRequestMicroUsd: runtime.options.maxCostPerRequestMicroUsd }),
            ...(runtime.options.maxAccumulatedCostMicroUsd === undefined
              ? {}
              : { maxAccumulatedCostMicroUsd: runtime.options.maxAccumulatedCostMicroUsd }),
          });

          if (!decision.allowed) {
            rejectBudget(runtime, ctx, request, scope, decision, estimate.costMicroUsd);
          }

          let reservedEstimate = 0;

          if (runtime.options.maxAccumulatedCostMicroUsd !== undefined) {
            const reserved = runtime.options.accountant.reserve(
              scope,
              estimate.costMicroUsd,
              runtime.options.maxAccumulatedCostMicroUsd,
            );

            if (!reserved) {
              rejectBudget(
                runtime,
                ctx,
                request,
                scope,
                {
                  allowed: false,
                  limitKind: "accumulated",
                  limitMicroUsd: runtime.options.maxAccumulatedCostMicroUsd,
                },
                estimate.costMicroUsd,
              );
            }

            reservedEstimate = estimate.costMicroUsd;
          }

          try {
            const result = await next(ctx);
            const recorded = recordActualCost(runtime, result, scope, reservedEstimate);

            if (
              recorded !== undefined &&
              runtime.options.maxAccumulatedCostMicroUsd !== undefined &&
              recorded.accumulatedMicroUsd >=
                Math.floor(
                  runtime.options.maxAccumulatedCostMicroUsd *
                    runtime.options.warningThresholdRatio +
                    0.5,
                )
            ) {
              runtime.events.emit({
                type: "LlmBudgetWarning",
                timestamp: ctx.startedAt,
                requestId: ctx.requestId,
                operationName: ctx.operationName,
                provider: request.provider,
                model: request.model,
                scope,
                accumulatedMicroUsd: recorded.accumulatedMicroUsd,
                limitMicroUsd: runtime.options.maxAccumulatedCostMicroUsd,
              });
            }

            return result;
          } catch (error) {
            if (runtime.options.maxAccumulatedCostMicroUsd !== undefined) {
              runtime.options.accountant.settle(scope, reservedEstimate, 0);
            }

            throw error;
          }
        },
      };
    },
  });
}

/**
 * @internal
 */
export function normalizeBudgetOptions(options: BudgetGuardOptions): NormalizedBudgetOptions {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("budget must be an object.", { field: "budget" });
  }

  const warningThresholdRatio = options.warningThresholdRatio ?? 0.8;
  const rawUnknownPricing: unknown = options.onUnknownPricing ?? "reject";

  if (
    typeof warningThresholdRatio !== "number" ||
    !Number.isFinite(warningThresholdRatio) ||
    warningThresholdRatio <= 0 ||
    warningThresholdRatio > 1
  ) {
    throw new ConfigurationError("budget.warningThresholdRatio must be in (0, 1].", {
      field: "budget.warningThresholdRatio",
    });
  }

  if (rawUnknownPricing !== "allow" && rawUnknownPricing !== "reject") {
    throw new ConfigurationError('budget.onUnknownPricing must be "allow" or "reject".', {
      field: "budget.onUnknownPricing",
    });
  }

  const onUnknownPricing: UnknownPricingBehavior = rawUnknownPricing;

  if (
    options.scope !== undefined &&
    typeof options.scope !== "string" &&
    typeof options.scope !== "function"
  ) {
    throw new ConfigurationError("budget.scope must be a string or function.", {
      field: "budget.scope",
    });
  }

  if (options.maxCostPerRequestUsd === undefined && options.maxAccumulatedCostUsd === undefined) {
    throw new ConfigurationError(
      "budget requires maxCostPerRequestUsd and/or maxAccumulatedCostUsd.",
      { field: "budget" },
    );
  }

  return {
    warningThresholdRatio,
    onUnknownPricing,
    accountant: options.accountant ?? createMemoryBudgetAccountant(),
    ...(options.maxCostPerRequestUsd === undefined
      ? {}
      : { maxCostPerRequestMicroUsd: usdToMicroUsd(options.maxCostPerRequestUsd) }),
    ...(options.maxAccumulatedCostUsd === undefined
      ? {}
      : { maxAccumulatedCostMicroUsd: usdToMicroUsd(options.maxAccumulatedCostUsd) }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  };
}

function rejectBudget(
  runtime: BudgetPolicyRuntime,
  ctx: Context,
  request: LlmRequest,
  scope: string,
  decision: {
    readonly allowed: false;
    readonly limitKind: BudgetLimitKind;
    readonly limitMicroUsd: number;
  },
  attemptedMicroUsd = 0,
): never {
  const accumulatedMicroUsd = runtime.options.accountant.getAccumulatedMicroUsd(scope);

  runtime.events.emit({
    type: "LlmBudgetRejected",
    timestamp: ctx.startedAt,
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    provider: request.provider,
    model: request.model,
    scope,
    limitKind: decision.limitKind,
    accumulatedMicroUsd,
    attemptedMicroUsd,
    limitMicroUsd: decision.limitMicroUsd,
  });

  throw new LlmBudgetExceededError({
    scope,
    limitKind: decision.limitKind,
    limitMicroUsd: decision.limitMicroUsd,
    accumulatedMicroUsd,
    attemptedMicroUsd,
    provider: request.provider,
    model: request.model,
  });
}

function getRequest(ctx: Context): LlmRequest {
  const request = ctx.metadata.get(LLM_REQUEST_METADATA_KEY);

  if (request === undefined || typeof request !== "object" || request === null) {
    throw new ConfigurationError("LLM request metadata is missing from context.", {
      field: "request",
    });
  }

  return request as LlmRequest;
}

function resolveScope(
  scope: string | BudgetScopeResolver | undefined,
  request: LlmRequest,
  ctx: Context,
): string {
  if (typeof scope === "function") {
    const resolved = scope(request, ctx);

    if (typeof resolved !== "string" || resolved.trim().length === 0) {
      throw new ConfigurationError("budget.scope resolver must return a non-empty string.", {
        field: "budget.scope",
      });
    }

    return resolved;
  }

  if (typeof scope === "string" && scope.trim().length > 0) {
    return scope;
  }

  return request.provider;
}

type CostEstimate =
  { readonly status: "known"; readonly costMicroUsd: number } | { readonly status: "unknown" };

function estimateCost(request: LlmRequest, pricing: PricingResolver | undefined): CostEstimate {
  if (pricing === undefined) {
    return { status: "unknown" };
  }

  const rate = pricing.resolve(request.provider, request.model);

  if (rate === undefined) {
    return { status: "unknown" };
  }

  const inputTokens = normalizeTokenCount(request.estimatedInputTokens);
  const outputTokens = normalizeTokenCount(request.estimatedOutputTokens);

  return {
    status: "known",
    costMicroUsd:
      tokenCostMicroUsd(inputTokens, rate.inputMicroUsdPerMillionTokens) +
      tokenCostMicroUsd(outputTokens, rate.outputMicroUsdPerMillionTokens),
  };
}

function recordActualCost(
  runtime: BudgetPolicyRuntime,
  result: unknown,
  scope: string,
  reservedMicroUsd: number,
): { readonly cost: LlmCost; readonly accumulatedMicroUsd: number } | undefined {
  if (runtime.options.maxAccumulatedCostMicroUsd === undefined) {
    return undefined;
  }

  let actualMicroUsd = 0;
  let cost: LlmCost | undefined;

  if (isLlmResponse(result) && runtime.pricing !== undefined) {
    const rate = runtime.pricing.resolve(result.provider, result.model);

    if (rate !== undefined) {
      cost = calculateCost(normalizeUsage(result.usage), rate);
      actualMicroUsd = cost.totalCostMicroUsd;
    }
  }

  const accumulatedMicroUsd = runtime.options.accountant.settle(
    scope,
    reservedMicroUsd,
    actualMicroUsd,
  );

  if (cost === undefined) {
    return undefined;
  }

  return { cost, accumulatedMicroUsd };
}

function isLlmResponse(value: unknown): value is LlmResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "usage" in value &&
    "provider" in value &&
    "model" in value
  );
}
