import type { Context } from "../../core/context";
import { AbortError, ConfigurationError } from "../../core/errors";
import { getOperationArgs } from "../../core/metadata";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";
import type { DedupeKey } from "../dedupe";

/**
 * Memory cache policy options.
 *
 * @public
 */
export interface CacheOptions<Args extends readonly unknown[] = readonly unknown[]> {
  /**
   * Resolves the cache key for one logical call from operation arguments.
   */
  readonly key: (...args: Args) => DedupeKey;

  /**
   * Time-to-live for cached successful results, in milliseconds.
   */
  readonly ttl: number;

  /**
   * Whether successful `undefined` results should be cached.
   */
  readonly cacheUndefined?: boolean;

  /**
   * Whether successful `null` results should be cached.
   */
  readonly cacheNull?: boolean;

  /**
   * Maximum number of entries retained by this policy instance.
   */
  readonly maxEntries?: number;
}

interface NormalizedCacheOptions {
  readonly key: (...args: readonly unknown[]) => DedupeKey;
  readonly ttl: number;
  readonly cacheUndefined: boolean;
  readonly cacheNull: boolean;
  readonly maxEntries: number;
}

interface CacheOptionsCandidate {
  readonly key?: unknown;
  readonly ttl?: unknown;
  readonly cacheUndefined?: unknown;
  readonly cacheNull?: unknown;
  readonly maxEntries?: unknown;
}

interface CacheEntry<R> {
  readonly value: R;
  readonly createdAt: number;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * Built-in memory cache policy factory.
 *
 * Pass {@link CacheOptions} as factory options.
 *
 * @public
 */
export const cachePolicy: PolicyFactory = definePolicy({
  name: "cache",
  order: 150,
  create(services: PolicyServices, options?: unknown) {
    const cacheOptions = normalizeOptions(options);
    const entries = new Map<DedupeKey, CacheEntry<unknown>>();

    return {
      name: "cache",
      order: 150,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithCache(ctx, next, services, cacheOptions, entries);
      },
    };
  },
});

async function executeWithCache<T>(
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  options: NormalizedCacheOptions,
  entries: Map<DedupeKey, CacheEntry<unknown>>,
): Promise<T> {
  if (ctx.signal.aborted) {
    throw createAbortError(ctx);
  }

  const key = resolveKey(options, ctx);
  const now = services.clock.now();
  const entry = entries.get(key);

  if (entry !== undefined) {
    if (!isExpired(entry, now)) {
      return entry.value as T;
    }

    entries.delete(key);
  }

  const value = await next(ctx);

  if (shouldCacheValue(value, options)) {
    storeValue(entries, key, value, services.clock.now(), options);
  }

  return value;
}

function resolveKey(options: NormalizedCacheOptions, ctx: Context): DedupeKey {
  const key = options.key(...getOperationArgs(ctx));

  validateCacheKey(key);

  return key;
}

function isExpired(entry: CacheEntry<unknown>, now: number): boolean {
  return now >= entry.expiresAt;
}

function shouldCacheValue(value: unknown, options: NormalizedCacheOptions): boolean {
  if (value === undefined) {
    return options.cacheUndefined;
  }

  if (value === null) {
    return options.cacheNull;
  }

  return true;
}

function storeValue(
  entries: Map<DedupeKey, CacheEntry<unknown>>,
  key: DedupeKey,
  value: unknown,
  now: number,
  options: NormalizedCacheOptions,
): void {
  if (entries.has(key)) {
    entries.delete(key);
  }

  removeExpiredEntries(entries, now);

  while (entries.size >= options.maxEntries) {
    const oldestKey = entries.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    entries.delete(oldestKey);
  }

  entries.set(
    key,
    Object.freeze({
      value,
      createdAt: now,
      expiresAt: resolveExpiresAt(now, options.ttl),
    }),
  );
}

function removeExpiredEntries(entries: Map<DedupeKey, CacheEntry<unknown>>, now: number): void {
  for (const [key, entry] of entries) {
    if (isExpired(entry, now)) {
      entries.delete(key);
    }
  }
}

function resolveExpiresAt(createdAt: number, ttl: number): number {
  const expiresAt = createdAt + ttl;

  return Number.isFinite(expiresAt) ? expiresAt : Number.MAX_VALUE;
}

function createAbortError(ctx: Context): Error {
  const reason: unknown = ctx.signal.reason;

  return reason instanceof Error ? reason : new AbortError({ reason, context: ctx.snapshot() });
}

function normalizeOptions(options: unknown): NormalizedCacheOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Cache options must be an object.", { field: "cache" });
  }

  const candidate = options as CacheOptionsCandidate;
  const cacheUndefined = candidate.cacheUndefined ?? false;
  const cacheNull = candidate.cacheNull ?? false;
  const maxEntries = candidate.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (typeof candidate.key !== "function") {
    throw new ConfigurationError("cache.key must be a function.", { field: "cache.key" });
  }

  validateTtl(candidate.ttl);

  if (typeof cacheUndefined !== "boolean") {
    throw new ConfigurationError("cache.cacheUndefined must be a boolean.", {
      field: "cache.cacheUndefined",
    });
  }

  if (typeof cacheNull !== "boolean") {
    throw new ConfigurationError("cache.cacheNull must be a boolean.", {
      field: "cache.cacheNull",
    });
  }

  validateMaxEntries(maxEntries);

  return Object.freeze({
    key: candidate.key as (...args: readonly unknown[]) => DedupeKey,
    ttl: candidate.ttl,
    cacheUndefined,
    cacheNull,
    maxEntries,
  });
}

function validateTtl(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError("cache.ttl must be a finite number greater than 0.", {
      field: "cache.ttl",
    });
  }
}

function validateMaxEntries(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    throw new ConfigurationError("cache.maxEntries must be a positive finite integer.", {
      field: "cache.maxEntries",
    });
  }
}

function validateCacheKey(key: unknown): asserts key is DedupeKey {
  if (typeof key === "string" || typeof key === "symbol") {
    return;
  }

  if (typeof key === "number" && Number.isFinite(key)) {
    return;
  }

  throw new ConfigurationError("cache.key must return a string, finite number, or symbol.", {
    field: "cache.key",
  });
}
