import type { Context } from "../../core/context";
import { ConfigurationError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

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
   *
   * Phase 1 policy-only execution invokes this without operation arguments;
   * builder wiring will supply `client.call(...args)` in a later phase.
   */
  readonly key: (...args: Args) => DedupeKey;

  /**
   * Future cancellation option. Phase 1 validates and stores this value but does
   * not implement independent subscriber cancellation.
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

interface InFlightEntry<T> {
  readonly key: DedupeKey;
  readonly promise: Promise<T>;
  readonly createdAt: number;
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
    const registry = new Map<DedupeKey, InFlightEntry<unknown>>();

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
  registry: Map<DedupeKey, InFlightEntry<unknown>>,
): Promise<T> {
  const key = resolveKey(options);
  const existing = registry.get(key) as InFlightEntry<T> | undefined;

  if (existing !== undefined && !existing.settled) {
    return await existing.promise;
  }

  const entry = createEntry(key, ctx, next, services, registry);
  registry.set(key, entry);

  return await entry.promise;
}

function createEntry<T>(
  key: DedupeKey,
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  registry: Map<DedupeKey, InFlightEntry<unknown>>,
): InFlightEntry<T> {
  const entryRef: { current?: InFlightEntry<T> } = {};
  const promise = Promise.resolve()
    .then(() => next(ctx))
    .finally(() => {
      const entry = entryRef.current;

      if (entry === undefined) {
        return;
      }

      entry.settled = true;

      if (registry.get(key) === entry) {
        registry.delete(key);
      }
    });
  const entry: InFlightEntry<T> = {
    key,
    promise,
    createdAt: services.clock.now(),
    settled: false,
  };
  entryRef.current = entry;

  void promise.catch(() => {
    // The shared promise remains safe even if a caller drops its returned promise.
  });

  return entry;
}

function resolveKey(options: NormalizedDedupeOptions): DedupeKey {
  const key = options.key();

  validateDedupeKey(key);

  return key;
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
