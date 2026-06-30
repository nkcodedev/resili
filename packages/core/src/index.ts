/**
 * Current package version placeholder.
 *
 * @public
 */
export const RESILI_VERSION = "0.0.0";

export type { FailureClassifier, FailureVerdict, Outcome } from "./core/classification/index";
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
export type { Counter, Gauge, Histogram, Labels, MetricsRecorder } from "./core/metrics/index";
export { noopMetrics } from "./core/metrics/index";
export type { Next, Policy, PolicyFactory, PolicyOrder, PolicyServices } from "./core/policy/index";
export { definePolicy } from "./core/policy/index";
export type { PolicyState, StateStore } from "./core/state/index";
export { memoryStore } from "./core/state/index";
