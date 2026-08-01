import { createContext, releaseContext, type Context } from "../../core/context";
import { AbortError, ConfigurationError, isResiliError } from "../../core/errors";
import {
  noopMetrics,
  type Counter,
  type Gauge,
  type Histogram,
  type Labels,
} from "../../core/metrics";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Internal metadata key used by client.call(...) to pass operation arguments to
 * the dedupe policy without changing the public Context API.
 */
export const DEDUPE_OPERATION_ARGS_METADATA_KEY = "resili.dedupe.args";

/**
 * Stable identifier used to share concurrent in-flight executions.
 *
 * @public
 */
export type DedupeKey = string | number | symbol;

/**
 * Request deduplication policy options.
 *
 * @public
 */
export interface DedupeOptions<Args extends readonly unknown[] = readonly unknown[]> {
  /**
   * Resolves the in-flight dedupe key for one logical caller.
   */
  readonly key: (...args: Args) => DedupeKey;

  /**
   * Whether to abort shared work when the final active logical caller detaches.
   */
  readonly abortSharedWhenUnused?: boolean;
}

interface NormalizedDedupeOptions {
  readonly key: (...args: readonly unknown[]) => DedupeKey;
  readonly abortSharedWhenUnused: boolean;
}

interface DedupeOptionsCandidate {
  readonly key?: unknown;
  readonly abortSharedWhenUnused?: unknown;
}

interface InFlightEntry {
  readonly key: DedupeKey;
  readonly keyType: KeyType;
  readonly sharedController: AbortController;
  readonly sharedContext: Context;
  readonly subscribers: Set<DedupeSubscriber>;
  readonly createdAt: number;
  readonly labels: Labels;
  sharedPromise: Promise<unknown>;
  activeSubscriberCount: number;
  totalCallers: number;
  joinedCallers: number;
  settled: boolean;
  cleanupDone: boolean;
  sharedAbortIssued: boolean;
  sharedResultRecorded: boolean;
}

interface DedupeSubscriber {
  readonly context: Context;
  readonly role: DedupeRole;
  readonly joinedAt: number;
  readonly signal: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cleanup: () => void;
  settled: boolean;
  resultRecorded: boolean;
}

type DedupeRole = "owner" | "joiner";
type CallerResult = "success" | "error" | "aborted";
type SharedResult = "success" | "error" | "aborted_unused";
type SharedDurationStatus = "success" | "failed" | "aborted";
type KeyType = "string" | "number" | "symbol";

/**
 * Built-in request deduplication policy factory.
 *
 * Pass {@link DedupeOptions} as factory options.
 *
 * @public
 */
export const dedupePolicy: PolicyFactory = definePolicy({
  name: "dedupe",
  order: 425,
  create(services: PolicyServices, options?: unknown) {
    const dedupeOptions = normalizeOptions(options);
    const registry = new Map<DedupeKey, InFlightEntry>();
    const metrics = createDedupeMetrics(services);
    const inflightEntriesByLabels = new Map<string, number>();

    return {
      name: "dedupe",
      order: 425,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithDedupe(ctx, next, services, dedupeOptions, registry, metrics, {
          increment(labels) {
            const key = labelsKey(labels);
            const value = (inflightEntriesByLabels.get(key) ?? 0) + 1;

            inflightEntriesByLabels.set(key, value);
            safeSetGauge(metrics.inflight, value, labels);
          },
          decrement(labels) {
            const key = labelsKey(labels);
            const value = Math.max(0, (inflightEntriesByLabels.get(key) ?? 0) - 1);

            if (value === 0) {
              inflightEntriesByLabels.delete(key);
            } else {
              inflightEntriesByLabels.set(key, value);
            }

            safeSetGauge(metrics.inflight, value, labels);
          },
        });
      },
    };
  },
});

interface InflightGaugeLifecycle {
  increment(labels: Labels): void;
  decrement(labels: Labels): void;
}

async function executeWithDedupe<T>(
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  options: NormalizedDedupeOptions,
  registry: Map<DedupeKey, InFlightEntry>,
  metrics: DedupeMetrics,
  inflightGauge: InflightGaugeLifecycle,
): Promise<T> {
  if (ctx.signal.aborted) {
    throw createAbortError(ctx);
  }

  const key = resolveKey(options, ctx);
  let entry = registry.get(key);
  let role: DedupeRole = "joiner";

  if (entry === undefined || entry.settled) {
    role = "owner";
    entry = createEntry(key, ctx, services);
    registry.set(key, entry);
    inflightGauge.increment(entry.labels);
    recordMiss(entry, services, metrics);
    startSharedExecution(entry, next, services, registry, metrics, inflightGauge);
  } else {
    recordJoin(entry, ctx, services, metrics);
  }

  return (await attachSubscriber(entry, ctx, role, options, services, metrics)) as T;
}

function createEntry(
  key: DedupeKey,
  ownerContext: Context,
  services: PolicyServices,
): InFlightEntry {
  const sharedController = new AbortController();
  const createdAt = services.clock.now();
  const sharedContext = createContext({
    requestId: ownerContext.requestId,
    operationName: ownerContext.operationName,
    serviceName: ownerContext.serviceName,
    attemptNumber: ownerContext.attemptNumber,
    metadata: ownerContext.metadata,
    signal: sharedController.signal,
    ...(Number.isFinite(ownerContext.deadline) ? { deadline: ownerContext.deadline } : {}),
    startedAt: ownerContext.startedAt,
  });

  return {
    key,
    keyType: getKeyType(key),
    sharedController,
    sharedContext,
    subscribers: new Set<DedupeSubscriber>(),
    sharedPromise: Promise.resolve(undefined as never),
    createdAt,
    labels: createMetricLabels(sharedContext),
    activeSubscriberCount: 0,
    totalCallers: 0,
    joinedCallers: 0,
    settled: false,
    cleanupDone: false,
    sharedAbortIssued: false,
    sharedResultRecorded: false,
  };
}

function startSharedExecution<T>(
  entry: InFlightEntry,
  next: Next<T>,
  services: PolicyServices,
  registry: Map<DedupeKey, InFlightEntry>,
  metrics: DedupeMetrics,
  inflightGauge: InflightGaugeLifecycle,
): void {
  const sharedPromise = Promise.resolve().then(() => next(entry.sharedContext));

  entry.sharedPromise = sharedPromise;
  void sharedPromise.then(
    (value) => {
      settleEntrySuccess(entry, value, services, metrics);
    },
    (error: unknown) => {
      settleEntryFailure(entry, error, services, metrics);
    },
  );
  void sharedPromise
    .catch(() => {
      // The shared promise remains observed even when every subscriber aborts.
    })
    .finally(() => {
      cleanupEntry(entry, services, registry, metrics, inflightGauge);
    });
}

function attachSubscriber(
  entry: InFlightEntry,
  ctx: Context,
  role: DedupeRole,
  options: NormalizedDedupeOptions,
  services: PolicyServices,
  metrics: DedupeMetrics,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    entry.totalCallers += 1;
    if (role === "joiner") {
      entry.joinedCallers += 1;
    }

    const subscriber: DedupeSubscriber = {
      context: ctx,
      role,
      joinedAt: services.clock.now(),
      signal: ctx.signal,
      resolve,
      reject,
      cleanup: noop,
      settled: false,
      resultRecorded: false,
    };

    if (ctx.signal.aborted) {
      settleSubscriber(
        entry,
        subscriber,
        "reject",
        createAbortError(ctx),
        "aborted",
        services,
        metrics,
        options,
      );
      return;
    }

    const onAbort = (): void => {
      settleSubscriber(
        entry,
        subscriber,
        "reject",
        createAbortError(ctx),
        "aborted",
        services,
        metrics,
        options,
      );
    };

    subscriber.cleanup = () => {
      ctx.signal.removeEventListener("abort", onAbort);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    entry.subscribers.add(subscriber);
    entry.activeSubscriberCount += 1;
  });
}

function settleEntrySuccess(
  entry: InFlightEntry,
  value: unknown,
  services: PolicyServices,
  metrics: DedupeMetrics,
): void {
  if (entry.settled) {
    return;
  }

  entry.settled = true;
  recordSharedResult(entry, services, metrics, "success", "success");
  emitCompleted(entry, services);

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(entry, subscriber, "resolve", value, "success", services, metrics);
  }
}

function settleEntryFailure(
  entry: InFlightEntry,
  error: unknown,
  services: PolicyServices,
  metrics: DedupeMetrics,
): void {
  if (entry.settled) {
    return;
  }

  entry.settled = true;
  recordSharedResult(entry, services, metrics, "error", "failed");
  emitFailed(entry, services, error);

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(entry, subscriber, "reject", error, "error", services, metrics);
  }
}

function settleSubscriber(
  entry: InFlightEntry,
  subscriber: DedupeSubscriber,
  action: "resolve" | "reject",
  result: unknown,
  callerResult: CallerResult,
  services: PolicyServices,
  metrics: DedupeMetrics,
  options?: NormalizedDedupeOptions,
): void {
  if (subscriber.settled) {
    return;
  }

  subscriber.settled = true;
  subscriber.cleanup();

  if (entry.subscribers.delete(subscriber)) {
    entry.activeSubscriberCount = Math.max(0, entry.activeSubscriberCount - 1);
  }

  recordCallerResult(entry, subscriber, services, metrics, callerResult);

  if (action === "resolve") {
    subscriber.resolve(result);
  } else {
    subscriber.reject(result);
  }

  if (
    !entry.settled &&
    options?.abortSharedWhenUnused === true &&
    entry.activeSubscriberCount === 0 &&
    !entry.sharedAbortIssued
  ) {
    entry.sharedAbortIssued = true;
    recordSharedResult(entry, services, metrics, "aborted_unused", "aborted");
    emitSharedAborted(entry, services);
    entry.sharedController.abort(
      createAbortErrorFromSignal(subscriber.signal, entry.sharedContext),
    );
  }
}

function cleanupEntry(
  entry: InFlightEntry,
  services: PolicyServices,
  registry: Map<DedupeKey, InFlightEntry>,
  metrics: DedupeMetrics,
  inflightGauge: InflightGaugeLifecycle,
): void {
  if (entry.cleanupDone) {
    return;
  }

  entry.cleanupDone = true;

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(
      entry,
      subscriber,
      "reject",
      createAbortError(entry.sharedContext),
      "error",
      services,
      metrics,
    );
  }

  entry.subscribers.clear();
  entry.activeSubscriberCount = 0;
  releaseContext(entry.sharedContext);
  inflightGauge.decrement(entry.labels);

  if (registry.get(entry.key) === entry) {
    registry.delete(entry.key);
  }
}

function resolveKey(options: NormalizedDedupeOptions, ctx: Context): DedupeKey {
  const key = options.key(...getOperationArgs(ctx));

  validateDedupeKey(key);

  return key;
}

function getOperationArgs(ctx: Context): readonly unknown[] {
  const args = ctx.metadata.get(DEDUPE_OPERATION_ARGS_METADATA_KEY);

  return Array.isArray(args) ? args : [];
}

function recordMiss(entry: InFlightEntry, services: PolicyServices, metrics: DedupeMetrics): void {
  safeRecordCounter(metrics.missesTotal, 1, entry.labels);
  services.emit({
    ...eventBase("DedupeMiss", entry.sharedContext, services.clock.now()),
    role: "owner",
    activeCallers: 1,
    createdAt: entry.createdAt,
    keyType: entry.keyType,
  });
}

function recordJoin(
  entry: InFlightEntry,
  ctx: Context,
  services: PolicyServices,
  metrics: DedupeMetrics,
): void {
  safeRecordCounter(metrics.joinsTotal, 1, entry.labels);
  services.emit({
    ...eventBase("DedupeJoined", ctx, services.clock.now()),
    role: "joiner",
    activeCallers: entry.activeSubscriberCount + 1,
    sharedAgeMs: elapsedMs(services.clock.now(), entry.createdAt),
    keyType: entry.keyType,
  });
}

function recordCallerResult(
  entry: InFlightEntry,
  subscriber: DedupeSubscriber,
  services: PolicyServices,
  metrics: DedupeMetrics,
  result: CallerResult,
): void {
  if (subscriber.resultRecorded) {
    return;
  }

  subscriber.resultRecorded = true;
  safeRecordCounter(metrics.callersTotal, 1, {
    ...createMetricLabels(subscriber.context),
    role: subscriber.role,
    result,
  });

  if (subscriber.role === "joiner") {
    safeRecordHistogram(metrics.joinWaitMs, elapsedMs(services.clock.now(), subscriber.joinedAt), {
      ...createMetricLabels(subscriber.context),
      result,
    });
  }

  if (result === "aborted") {
    emitCallerAborted(entry, subscriber, services);
  }
}

function recordSharedResult(
  entry: InFlightEntry,
  services: PolicyServices,
  metrics: DedupeMetrics,
  result: SharedResult,
  status: SharedDurationStatus,
): void {
  if (entry.sharedResultRecorded) {
    return;
  }

  entry.sharedResultRecorded = true;
  safeRecordCounter(metrics.sharedExecutionsTotal, 1, {
    ...entry.labels,
    result,
  });
  safeRecordHistogram(metrics.durationMs, elapsedMs(services.clock.now(), entry.createdAt), {
    ...entry.labels,
    status,
  });
}

function emitCompleted(entry: InFlightEntry, services: PolicyServices): void {
  if (entry.sharedAbortIssued) {
    return;
  }

  services.emit({
    ...eventBase("DedupeCompleted", entry.sharedContext, services.clock.now()),
    activeCallersAtCompletion: entry.activeSubscriberCount,
    totalCallers: entry.totalCallers,
    joinedCallers: entry.joinedCallers,
    durationMs: elapsedMs(services.clock.now(), entry.createdAt),
    sharedAborted: false,
  });
}

function emitFailed(entry: InFlightEntry, services: PolicyServices, error: unknown): void {
  if (entry.sharedAbortIssued) {
    return;
  }

  services.emit({
    ...eventBase("DedupeFailed", entry.sharedContext, services.clock.now()),
    activeCallersAtFailure: entry.activeSubscriberCount,
    totalCallers: entry.totalCallers,
    joinedCallers: entry.joinedCallers,
    durationMs: elapsedMs(services.clock.now(), entry.createdAt),
    ...(isResiliError(error) ? { lastErrorCode: error.code } : {}),
  });
}

function emitCallerAborted(
  entry: InFlightEntry,
  subscriber: DedupeSubscriber,
  services: PolicyServices,
): void {
  const reason: unknown = subscriber.signal.reason;

  services.emit({
    ...eventBase("DedupeCallerAborted", subscriber.context, services.clock.now()),
    role: subscriber.role,
    activeCallersAfterDetach: entry.activeSubscriberCount,
    sharedStillRunning: !entry.settled,
    ...(isResiliError(reason) ? { reasonCode: reason.code } : {}),
  });
}

function emitSharedAborted(entry: InFlightEntry, services: PolicyServices): void {
  services.emit({
    ...eventBase("DedupeSharedAborted", entry.sharedContext, services.clock.now()),
    totalCallers: entry.totalCallers,
    joinedCallers: entry.joinedCallers,
    durationMs: elapsedMs(services.clock.now(), entry.createdAt),
    reason: "unused",
  });
}

function eventBase<Type extends string>(
  type: Type,
  ctx: Context,
  timestamp: number,
): {
  readonly type: Type;
  readonly timestamp: number;
  readonly requestId: string;
  readonly operationName: string;
  readonly serviceName: string;
} {
  return {
    type,
    timestamp,
    requestId: ctx.requestId,
    operationName: ctx.operationName,
    serviceName: ctx.serviceName,
  };
}

function createMetricLabels(ctx: Context): Labels {
  return Object.freeze({
    service: ctx.serviceName,
    operation: ctx.operationName,
  });
}

function getKeyType(key: DedupeKey): KeyType {
  if (typeof key === "string") {
    return "string";
  }

  if (typeof key === "number") {
    return "number";
  }

  return "symbol";
}

function elapsedMs(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000");
}

function normalizeOptions(options: unknown): NormalizedDedupeOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Dedupe options must be an object.", { field: "dedupe" });
  }

  const candidate = options as DedupeOptionsCandidate;
  const abortSharedWhenUnused = candidate.abortSharedWhenUnused ?? true;

  if (typeof candidate.key !== "function") {
    throw new ConfigurationError("dedupe.key must be a function.", { field: "dedupe.key" });
  }

  if (typeof abortSharedWhenUnused !== "boolean") {
    throw new ConfigurationError("dedupe.abortSharedWhenUnused must be a boolean.", {
      field: "dedupe.abortSharedWhenUnused",
    });
  }

  return Object.freeze({
    key: candidate.key as (...args: readonly unknown[]) => DedupeKey,
    abortSharedWhenUnused,
  });
}

function validateDedupeKey(key: unknown): asserts key is DedupeKey {
  if (typeof key === "string" || typeof key === "symbol") {
    return;
  }

  if (typeof key === "number" && Number.isFinite(key)) {
    return;
  }

  throw new ConfigurationError("dedupe.key must return a string, finite number, or symbol.", {
    field: "dedupe.key",
  });
}

interface DedupeMetrics {
  readonly missesTotal: Counter;
  readonly joinsTotal: Counter;
  readonly callersTotal: Counter;
  readonly sharedExecutionsTotal: Counter;
  readonly durationMs: Histogram;
  readonly joinWaitMs: Histogram;
  readonly inflight: Gauge;
}

function createDedupeMetrics(services: PolicyServices): DedupeMetrics {
  return Object.freeze({
    missesTotal: safeCounter(
      services,
      "resili_dedupe_misses_total",
      "Request deduplication shared execution misses.",
    ),
    joinsTotal: safeCounter(
      services,
      "resili_dedupe_joins_total",
      "Request deduplication logical callers joined.",
    ),
    callersTotal: safeCounter(
      services,
      "resili_dedupe_callers_total",
      "Request deduplication logical caller results.",
    ),
    sharedExecutionsTotal: safeCounter(
      services,
      "resili_dedupe_shared_executions_total",
      "Request deduplication shared execution results.",
    ),
    durationMs: safeHistogram(
      services,
      "resili_dedupe_duration_ms",
      "Request deduplication shared execution duration in milliseconds.",
    ),
    joinWaitMs: safeHistogram(
      services,
      "resili_dedupe_join_wait_ms",
      "Request deduplication joiner wait duration in milliseconds.",
    ),
    inflight: safeGauge(
      services,
      "resili_dedupe_inflight",
      "Request deduplication in-flight shared executions.",
    ),
  });
}

function safeCounter(services: PolicyServices, name: string, help: string): Counter {
  try {
    return services.metrics.counter(name, help);
  } catch {
    return noopMetrics.counter(name, help);
  }
}

function safeGauge(services: PolicyServices, name: string, help: string): Gauge {
  try {
    return services.metrics.gauge(name, help);
  } catch {
    return noopMetrics.gauge(name, help);
  }
}

function safeHistogram(services: PolicyServices, name: string, help: string): Histogram {
  try {
    return services.metrics.histogram(name, help);
  } catch {
    return noopMetrics.histogram(name, help);
  }
}

function safeRecordCounter(counter: Counter, value: number, labels?: Labels): void {
  try {
    counter.add(value, labels);
  } catch {
    // Metrics recorders must not affect request execution.
  }
}

function safeSetGauge(gauge: Gauge, value: number, labels?: Labels): void {
  try {
    gauge.set(value, labels);
  } catch {
    // Metrics recorders must not affect request execution.
  }
}

function safeRecordHistogram(histogram: Histogram, value: number, labels?: Labels): void {
  try {
    histogram.record(value, labels);
  } catch {
    // Metrics recorders must not affect request execution.
  }
}

function createAbortError(ctx: Context): Error {
  return createAbortErrorFromSignal(ctx.signal, ctx);
}

function createAbortErrorFromSignal(signal: AbortSignal, ctx: Context): Error {
  const reason: unknown = signal.reason;

  return reason instanceof Error ? reason : new AbortError({ reason, context: ctx.snapshot() });
}

function noop(): void {
  // Intentionally empty.
}
