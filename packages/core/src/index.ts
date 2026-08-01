/**
 * Current package version placeholder.
 *
 * @public
 */
import { createBuilder, type Builder, type Operation } from "./core/builder/index";
import type { Client } from "./core/client/index";
import type { FailureClassifier } from "./core/classification/index";
import type { Clock } from "./core/clock/index";
import { ConfigurationError } from "./core/errors/index";
import type { PolicyFactory } from "./core/policy/index";
import type { StateStore } from "./core/state/index";
import type { BulkheadOptions } from "./policies/bulkhead/index";
import type { CircuitBreakerOptions } from "./policies/circuit-breaker/index";
import type { FallbackFn, FallbackOptions } from "./policies/fallback/index";
import type { HedgeOptions } from "./policies/hedge/index";
import type { RateLimiterOptions } from "./policies/rate-limiter/index";
import type { RetryOptions } from "./policies/retry/index";
import type { TimeoutOptions } from "./policies/timeout/index";

export const RESILI_VERSION = "0.0.0";

/**
 * Supported declarative client configuration.
 *
 * @public
 */
export interface ResiliConfig<R = unknown> {
  readonly retry?: RetryOptions;
  readonly timeout?: number | TimeoutOptions;
  readonly hedge?: HedgeOptions<R>;
  readonly circuitBreaker?: CircuitBreakerOptions;
  readonly bulkhead?: number | BulkheadOptions;
  readonly rateLimiter?: RateLimiterOptions;
  readonly fallback?: FallbackOptions<R> | FallbackFn<R>;
  readonly classifier?: FailureClassifier;
  readonly store?: StateStore;
  readonly clock?: Clock;
  readonly policies?: readonly {
    readonly factory: PolicyFactory;
    readonly options?: unknown;
  }[];
}

/**
 * Primary fluent entry point.
 *
 * @public
 */
export function resili<Args extends readonly unknown[], R>(
  operation: Operation<Args, R>,
): Builder<Args, R> {
  return createBuilder(operation);
}

/**
 * Secondary declarative entry point.
 *
 * @public
 */
export function createClient<Args extends readonly unknown[], R>(
  operation: Operation<Args, R>,
  config: ResiliConfig<R> = {},
): Client<Args, R> {
  validateConfig(config);

  let builder = resili(operation);

  if (config.classifier !== undefined) {
    builder = builder.withClassifier(config.classifier);
  }

  if (config.store !== undefined) {
    builder = builder.withStore(config.store);
  }

  if (config.clock !== undefined) {
    builder = builder.withClock(config.clock);
  }

  if (config.retry !== undefined) {
    builder = builder.retry(config.retry);
  }

  if (config.timeout !== undefined) {
    builder = builder.timeout(config.timeout);
  }

  if (config.hedge !== undefined) {
    builder = builder.hedge(config.hedge);
  }

  if (config.circuitBreaker !== undefined) {
    builder = builder.circuitBreaker(config.circuitBreaker);
  }

  if (config.bulkhead !== undefined) {
    builder = builder.bulkhead(config.bulkhead);
  }

  if (config.rateLimiter !== undefined) {
    builder = builder.rateLimiter(config.rateLimiter);
  }

  if (config.fallback !== undefined) {
    builder = builder.fallback(config.fallback);
  }

  for (const registration of config.policies ?? []) {
    builder = builder.policy(registration.factory, registration.options);
  }

  return builder.build();
}

const SUPPORTED_CONFIG_KEYS = new Set<string>([
  "retry",
  "timeout",
  "hedge",
  "circuitBreaker",
  "bulkhead",
  "rateLimiter",
  "fallback",
  "classifier",
  "store",
  "clock",
  "policies",
]);

function validateConfig(config: unknown): asserts config is ResiliConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigurationError("Client config must be an object.", { field: "config" });
  }

  for (const key of Object.keys(config)) {
    if (!SUPPORTED_CONFIG_KEYS.has(key)) {
      throw new ConfigurationError(`Unsupported client config field: ${key}.`, {
        field: key,
      });
    }
  }
}

export type { FailureClassifier, FailureVerdict, Outcome } from "./core/classification/index";
export type { Builder, Operation } from "./core/builder/index";
export type { CircuitState, Client, ClientHealth, ClientStats } from "./core/client/index";
export { composeClassifier, httpClassifier } from "./core/classification/index";
export type { Clock } from "./core/clock/index";
export { systemClock } from "./core/clock/index";
export type { Context, ContextForkPatch, ContextInit, ContextSnapshot } from "./core/context";
export type {
  EventHandler,
  ResiliEvent,
  ResiliEventBase,
  ResiliEventMap,
  ResiliEventType,
  Unsubscribe,
} from "./core/events/index";
export type { ResiliErrorCode } from "./core/errors/index";
export {
  AbortError,
  BulkheadRejectedError,
  CircuitOpenError,
  ConfigurationError,
  RateLimitExceededError,
  ResiliError,
  RetryExceededError,
  TimeoutError,
  isResiliError,
} from "./core/errors/index";
export type { Counter, Gauge, Histogram, Labels, MetricsRecorder } from "./core/metrics/index";
export { noopMetrics } from "./core/metrics/index";
export type { Next, Policy, PolicyFactory, PolicyOrder, PolicyServices } from "./core/policy/index";
export { definePolicy } from "./core/policy/index";
export type { PluginContext, PluginInstance, ResiliPlugin } from "./core/plugins/index";
export { definePlugin } from "./core/plugins/index";
export type { PolicyState, StateStore } from "./core/state/index";
export { memoryStore } from "./core/state/index";
export type { BulkheadOptions } from "./policies/bulkhead/index";
export { bulkheadPolicy } from "./policies/bulkhead/index";
export type { CircuitBreakerOptions, KeyResolver } from "./policies/circuit-breaker/index";
export { circuitBreakerPolicy } from "./policies/circuit-breaker/index";
export type { FallbackFn, FallbackOptions } from "./policies/fallback/index";
export { fallbackPolicy } from "./policies/fallback/index";
export type { HedgeOptions } from "./policies/hedge/index";
export { hedgePolicy } from "./policies/hedge/index";
export type { RateLimiterOptions } from "./policies/rate-limiter/index";
export { rateLimiterPolicy } from "./policies/rate-limiter/index";
export type { RetryOptions, RetryPredicate } from "./policies/retry/index";
export { retryPolicy } from "./policies/retry/index";
export type { TimeoutOptions } from "./policies/timeout/index";
export { timeoutPolicy } from "./policies/timeout/index";
