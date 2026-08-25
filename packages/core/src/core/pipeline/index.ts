import { systemClock, type Clock } from "../clock";
import { createContext, releaseContext, type Context, type ContextInit } from "../context";
import type { EventBus } from "../events";
import { isResiliError } from "../errors";
import type { Next, Policy, PolicyOrder } from "../policy";

/**
 * The innermost unit of work, executed under a Context.
 *
 * @public
 */
export type Operation<T> = (ctx: Context) => Promise<T>;

/**
 * A composed, immutable chain of policies.
 *
 * @internal
 */
export interface Pipeline {
  readonly policies: readonly Policy[];
  execute<T>(operation: Operation<T>, ctx?: ContextInit): Promise<T>;
}

/**
 * Optional runtime collaborators for top-level request lifecycle events.
 *
 * @internal
 */
export interface PipelineRuntime {
  readonly events?: EventBus;
  readonly clock?: Clock;
}

/**
 * Compiles an ordered array of policies into a pipeline execution chain.
 *
 * @internal
 */
export function compilePipeline(policies: Policy[], runtime: PipelineRuntime = {}): Pipeline {
  const sortedPolicies = sortPolicies(policies);
  const events = runtime.events;
  const clock = runtime.clock ?? systemClock;

  return {
    policies: Object.freeze(sortedPolicies),
    async execute<T>(operation: Operation<T>, ctxInit?: ContextInit): Promise<T> {
      const rootContext = createContext(ctxInit ?? {});
      const startedAt = clock.now();
      let attempts = rootContext.attemptNumber;
      const unsubscribeRetryAttempts =
        events === undefined
          ? undefined
          : events.on("RetryStarted", (event) => {
              if (event.requestId === rootContext.requestId) {
                attempts = Math.max(attempts, event.attemptNumber);
              }
            });

      emitRequestStarted(events, clock, rootContext);

      try {
        const chain = buildExecutionChain(sortedPolicies, operation);
        const result = await chain(rootContext);
        emitRequestCompleted(events, clock, rootContext, startedAt, attempts, undefined);

        return result;
      } catch (error) {
        emitRequestCompleted(events, clock, rootContext, startedAt, attempts, error);
        throw error;
      } finally {
        unsubscribeRetryAttempts?.();
        releaseContext(rootContext);
      }
    },
  };
}

function emitRequestStarted(events: EventBus | undefined, clock: Clock, ctx: Context): void {
  events?.emit({
    type: "RequestStarted",
    timestamp: clock.now(),
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    deadline: ctx.deadline,
  });
}

function emitRequestCompleted(
  events: EventBus | undefined,
  clock: Clock,
  ctx: Context,
  startedAt: number,
  attempts: number,
  error: unknown,
): void {
  if (events === undefined) {
    return;
  }

  events.emit({
    type: "RequestCompleted",
    timestamp: clock.now(),
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
    durationMs: Math.max(0, clock.now() - startedAt),
    status: error === undefined ? "success" : "error",
    attempts,
    ...(error !== undefined && isResiliError(error) ? { errorCode: error.code } : {}),
  });
}

interface OrderedPolicy {
  readonly policy: Policy;
  readonly order: number;
  readonly index: number;
}

const BUILTIN_POLICY_ORDER: Readonly<Record<string, number>> = Object.freeze({
  fallback: 100,
  cache: 150,
  retry: 200,
  "circuit-breaker": 300,
  timeout: 400,
  dedupe: 425,
  hedge: 450,
  "rate-limiter": 500,
  bulkhead: 600,
});

const RELATIVE_ORDER_OFFSET = 0.5;

/**
 * Sorts policies by resolved order while preserving input order for ties.
 *
 * @internal
 */
function sortPolicies(policies: readonly Policy[]): Policy[] {
  return policies
    .map<OrderedPolicy>((policy, index) => ({
      policy,
      order: getPolicyOrderValue(policy.order),
      index,
    }))
    .sort(compareOrderedPolicies)
    .map(({ policy }) => policy);
}

function compareOrderedPolicies(left: OrderedPolicy, right: OrderedPolicy): number {
  const orderDifference = left.order - right.order;

  return orderDifference === 0 ? left.index - right.index : orderDifference;
}

/**
 * Builds the execution chain by wrapping each policy around the next.
 *
 * @internal
 */
function buildExecutionChain<T>(policies: Policy[], operation: Operation<T>): Next<T> {
  let chain: Next<T> = operation;

  for (let i = policies.length - 1; i >= 0; i--) {
    const policy = policies[i];
    const next = chain;

    if (policy === undefined) {
      continue;
    }

    chain = (ctx: Context) => policy.execute(ctx, next);
  }

  return chain;
}

/**
 * Converts a PolicyOrder to a numeric value for sorting.
 *
 * @internal
 */
function getPolicyOrderValue(order: PolicyOrder): number {
  if (typeof order === "number") {
    return order;
  }

  if ("before" in order) {
    const anchorOrder = BUILTIN_POLICY_ORDER[order.before] ?? Number.MAX_SAFE_INTEGER;

    return anchorOrder - RELATIVE_ORDER_OFFSET;
  }

  if ("after" in order) {
    const anchorOrder = BUILTIN_POLICY_ORDER[order.after] ?? Number.MAX_SAFE_INTEGER;

    return anchorOrder + RELATIVE_ORDER_OFFSET;
  }

  return Number.MAX_SAFE_INTEGER;
}
