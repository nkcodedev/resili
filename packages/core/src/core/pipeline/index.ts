import type { Context } from "../context";
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
  readonly policies: ReadonlyArray<Policy>;
  execute<T>(operation: Operation<T>, ctx?: Partial<Context>): Promise<T>;
}

/**
 * Compiles an ordered array of policies into a pipeline execution chain.
 *
 * @internal
 */
export function compilePipeline(policies: Policy[]): Pipeline {
  // Sort policies by their order hint
  const sortedPolicies = [...policies].sort((a, b) => {
    const orderA = getPolicyOrderValue(a.order);
    const orderB = getPolicyOrderValue(b.order);
    return orderA - orderB;
  });

  return {
    policies: Object.freeze(sortedPolicies),
    execute<T>(operation: Operation<T>, ctxInit?: Partial<Context>): Promise<T> {
      // Create root context
      const rootContext = createContext(ctxInit ?? {});
      
      // Build the middleware chain from innermost to outermost
      const chain = buildExecutionChain(sortedPolicies, operation);
      
      return chain(rootContext);
    },
  };
}

/**
 * Builds the execution chain by wrapping each policy around the next.
 *
 * @internal
 */
function buildExecutionChain<T>(policies: Policy[], operation: Operation<T>): Next<T> {
  // Start with the innermost operation
  let chain: Next<T> = operation;
  
  // Wrap each policy around the current chain, from outermost to innermost
  for (let i = policies.length - 1; i >= 0; i--) {
    const policy = policies[i];
    const next = chain;
    
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
  
  // For relative orders, we'll use a default mapping based on canonical order
  // This is a simplified approach - in practice this would be more sophisticated
  const builtinOrderMap: Record<string, number> = {
    fallback: 100,
    retry: 200,
    "circuit-breaker": 300,
    timeout: 400,
    "rate-limiter": 500,
    bulkhead: 600,
  };
  
  if ("before" in order) {
    return builtinOrderMap[order.before] ?? Number.MAX_SAFE_INTEGER;
  }
  
  if ("after" in order) {
    return builtinOrderMap[order.after] ?? Number.MAX_SAFE_INTEGER;
  }
  
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Creates a root context for pipeline execution.
 *
 * @internal
 */
function createContext(ctxInit: Partial<Context>): Context {
  // This would be implemented by importing the actual createContext function
  // For now, we'll return a minimal placeholder that satisfies the interface
  throw new Error("Not implemented - would use actual createContext from context module");
}
```