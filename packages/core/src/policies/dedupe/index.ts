import { createContext, releaseContext, type Context } from "../../core/context";
import { AbortError, ConfigurationError } from "../../core/errors";
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
  readonly sharedController: AbortController;
  readonly sharedContext: Context;
  readonly subscribers: Set<DedupeSubscriber>;
  readonly createdAt: number;
  sharedPromise: Promise<unknown>;
  activeSubscriberCount: number;
  settled: boolean;
  cleanupDone: boolean;
  sharedAbortIssued: boolean;
}

interface DedupeSubscriber {
  readonly signal: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cleanup: () => void;
  settled: boolean;
}

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

    return {
      name: "dedupe",
      order: 425,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithDedupe(ctx, next, services, dedupeOptions, registry);
      },
    };
  },
});

async function executeWithDedupe<T>(
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  options: NormalizedDedupeOptions,
  registry: Map<DedupeKey, InFlightEntry>,
): Promise<T> {
  if (ctx.signal.aborted) {
    throw createAbortError(ctx);
  }

  const key = resolveKey(options, ctx);
  let entry = registry.get(key);

  if (entry === undefined || entry.settled) {
    entry = createEntry(key, ctx, services);
    registry.set(key, entry);
    startSharedExecution(entry, next, registry);
  }

  return (await attachSubscriber(entry, ctx, options)) as T;
}

function createEntry(
  key: DedupeKey,
  ownerContext: Context,
  services: PolicyServices,
): InFlightEntry {
  const sharedController = new AbortController();
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
    sharedController,
    sharedContext,
    subscribers: new Set<DedupeSubscriber>(),
    sharedPromise: Promise.resolve(undefined as never),
    createdAt: services.clock.now(),
    activeSubscriberCount: 0,
    settled: false,
    cleanupDone: false,
    sharedAbortIssued: false,
  };
}

function startSharedExecution<T>(
  entry: InFlightEntry,
  next: Next<T>,
  registry: Map<DedupeKey, InFlightEntry>,
): void {
  const sharedPromise = Promise.resolve().then(() => next(entry.sharedContext));

  entry.sharedPromise = sharedPromise;
  void sharedPromise.then(
    (value) => {
      settleEntrySuccess(entry, value);
    },
    (error: unknown) => {
      settleEntryFailure(entry, error);
    },
  );
  void sharedPromise
    .catch(() => {
      // The shared promise remains observed even when every subscriber aborts.
    })
    .finally(() => {
      cleanupEntry(entry, registry);
    });
}

function attachSubscriber(
  entry: InFlightEntry,
  ctx: Context,
  options: NormalizedDedupeOptions,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const subscriber: DedupeSubscriber = {
      signal: ctx.signal,
      resolve,
      reject,
      cleanup: noop,
      settled: false,
    };

    if (ctx.signal.aborted) {
      settleSubscriber(entry, subscriber, "reject", createAbortError(ctx), options);
      return;
    }

    const onAbort = (): void => {
      settleSubscriber(entry, subscriber, "reject", createAbortError(ctx), options);
    };

    subscriber.cleanup = () => {
      ctx.signal.removeEventListener("abort", onAbort);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    entry.subscribers.add(subscriber);
    entry.activeSubscriberCount += 1;
  });
}

function settleEntrySuccess(entry: InFlightEntry, value: unknown): void {
  if (entry.settled) {
    return;
  }

  entry.settled = true;

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(entry, subscriber, "resolve", value);
  }
}

function settleEntryFailure(entry: InFlightEntry, error: unknown): void {
  if (entry.settled) {
    return;
  }

  entry.settled = true;

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(entry, subscriber, "reject", error);
  }
}

function settleSubscriber(
  entry: InFlightEntry,
  subscriber: DedupeSubscriber,
  action: "resolve" | "reject",
  result: unknown,
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
    entry.sharedController.abort(
      createAbortErrorFromSignal(subscriber.signal, entry.sharedContext),
    );
  }
}

function cleanupEntry(entry: InFlightEntry, registry: Map<DedupeKey, InFlightEntry>): void {
  if (entry.cleanupDone) {
    return;
  }

  entry.cleanupDone = true;

  for (const subscriber of [...entry.subscribers]) {
    settleSubscriber(entry, subscriber, "reject", createAbortError(entry.sharedContext));
  }

  entry.subscribers.clear();
  entry.activeSubscriberCount = 0;
  releaseContext(entry.sharedContext);

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
