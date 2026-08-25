import type { FailureClassifier } from "../classification";
import type { Clock } from "../clock";
import type { Context } from "../context";
import type { ResiliEvent } from "../events";
import { ConfigurationError } from "../errors";
import type { MetricsRecorder } from "../metrics";
import type { StateStore } from "../state";

/**
 * Built-in policy names that can be used as relative ordering anchors.
 *
 * @public
 */
export type PolicyOrder =
  | number
  | {
      readonly before:
        | "fallback"
        | "cache"
        | "retry"
        | "circuit-breaker"
        | "timeout"
        | "dedupe"
        | "hedge"
        | "rate-limiter"
        | "bulkhead";
    }
  | {
      readonly after:
        | "fallback"
        | "cache"
        | "retry"
        | "circuit-breaker"
        | "timeout"
        | "dedupe"
        | "hedge"
        | "rate-limiter"
        | "bulkhead";
    };

/**
 * Continuation invoked by a policy to call the next policy in the execution
 * pipeline.
 *
 * @public
 */
export type Next<T> = (ctx: Context) => Promise<T>;

/**
 * Resolves a policy partition key from the current context.
 *
 * Shared by circuit breaker, bulkhead, and rate limiter options.
 *
 * @public
 */
export type KeyResolver = (ctx: Context) => string;

/**
 * Middleware abstraction implemented by built-in and custom policies.
 *
 * A policy may observe, short-circuit, retry, time-box, or wrap the downstream
 * `next` continuation. It must preserve deterministic execution and propagate
 * the current {@link Context} to downstream work.
 *
 * @public
 */
export interface Policy {
  /**
   * Human-readable policy name.
   */
  readonly name: string;

  /**
   * Absolute or relative order hint used by the future pipeline compiler.
   */
  readonly order: PolicyOrder;

  /**
   * Executes this policy around the next pipeline continuation.
   */
  execute<T>(ctx: Context, next: Next<T>): Promise<T>;
}

/**
 * Client-scoped collaborators available to policy factories.
 *
 * These services are injected by the builder/client layer so policies remain
 * deterministic and independent from concrete infrastructure implementations.
 *
 * @public
 */
export interface PolicyServices {
  /**
   * Deterministic source of time and timers.
   */
  readonly clock: Clock;

  /**
   * Vendor-neutral metrics recorder.
   */
  readonly metrics: MetricsRecorder;

  /**
   * Synchronous event publishing function.
   */
  readonly emit: (event: ResiliEvent) => void;

  /**
   * Shared policy runtime state store.
   */
  readonly store: StateStore;

  /**
   * Shared failure classifier.
   */
  readonly classifier: FailureClassifier;
}

/**
 * Factory used by builders and plugins to create immutable policy instances.
 *
 * @public
 */
export interface PolicyFactory {
  /**
   * Human-readable factory name.
   */
  readonly name: string;

  /**
   * Order hint applied to policies created by this factory.
   */
  readonly order: PolicyOrder;

  /**
   * Creates a policy for one immutable client.
   */
  create(services: PolicyServices, options?: unknown): Policy;
}

/**
 * Defines a custom policy factory.
 *
 * The returned factory is immutable. Every policy produced through it is
 * validated and frozen, preserving the Open/Closed extension contract while
 * keeping pipeline composition independent from concrete policy classes.
 *
 * @public
 */
export function definePolicy(factory: PolicyFactory): PolicyFactory {
  validatePolicyFactory(factory);

  const order = freezePolicyOrder(factory.order);

  return Object.freeze({
    name: factory.name,
    order,
    create(services: PolicyServices, options?: unknown): Policy {
      const policy = factory.create(services, options);

      return freezePolicy(policy);
    },
  });
}

function freezePolicy(policy: Policy): Policy {
  validatePolicy(policy);
  Object.freeze(policy);

  return Object.freeze({
    name: policy.name,
    order: freezePolicyOrder(policy.order),
    execute: policy.execute.bind(policy),
  });
}

function freezePolicyOrder(order: PolicyOrder): PolicyOrder {
  validatePolicyOrder(order);

  if (typeof order === "number") {
    return order;
  }

  return Object.freeze({ ...order });
}

function validatePolicyFactory(factory: unknown): asserts factory is PolicyFactory {
  if (factory === null || typeof factory !== "object") {
    throw new ConfigurationError("Policy factory must be an object.", { field: "policy" });
  }

  const candidate = factory as Partial<PolicyFactory>;

  validateName(candidate.name, "policy.name");
  validatePolicyOrder(candidate.order);

  if (typeof candidate.create !== "function") {
    throw new ConfigurationError("Policy factory create must be a function.", {
      field: "policy.create",
    });
  }
}

function validatePolicy(policy: unknown): asserts policy is Policy {
  if (policy === null || typeof policy !== "object") {
    throw new ConfigurationError("Policy factory must create a policy object.", {
      field: "policy.create",
    });
  }

  const candidate = policy as Partial<Policy>;

  validateName(candidate.name, "policy.name");
  validatePolicyOrder(candidate.order);

  if (typeof candidate.execute !== "function") {
    throw new ConfigurationError("Policy execute must be a function.", {
      field: "policy.execute",
    });
  }
}

function validateName(name: unknown, field: string): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty string.`, { field });
  }
}

function validatePolicyOrder(order: unknown): asserts order is PolicyOrder {
  if (typeof order === "number") {
    if (!Number.isFinite(order)) {
      throw new ConfigurationError("Policy order must be a finite number.", {
        field: "policy.order",
      });
    }

    return;
  }

  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    throw new ConfigurationError("Policy order must be a number or relative order object.", {
      field: "policy.order",
    });
  }

  const relativeOrder = order as Readonly<Record<string, unknown>>;
  const hasBefore = "before" in relativeOrder;
  const hasAfter = "after" in relativeOrder;

  if (hasBefore === hasAfter) {
    throw new ConfigurationError("Policy order must specify exactly one relative anchor.", {
      field: "policy.order",
    });
  }

  const anchor = hasBefore ? relativeOrder["before"] : relativeOrder["after"];

  if (!isBuiltinPolicyAnchor(anchor)) {
    throw new ConfigurationError("Policy order anchor is not supported.", {
      field: "policy.order",
    });
  }
}

function isBuiltinPolicyAnchor(
  value: unknown,
): value is
  | "fallback"
  | "cache"
  | "retry"
  | "circuit-breaker"
  | "timeout"
  | "dedupe"
  | "hedge"
  | "rate-limiter"
  | "bulkhead" {
  return (
    value === "fallback" ||
    value === "cache" ||
    value === "retry" ||
    value === "circuit-breaker" ||
    value === "timeout" ||
    value === "dedupe" ||
    value === "hedge" ||
    value === "rate-limiter" ||
    value === "bulkhead"
  );
}
