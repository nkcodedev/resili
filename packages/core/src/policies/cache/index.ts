import type { Context } from "../../core/context";
import type { CacheEventKeyType, CacheEventValueType } from "../../core/events";
import { AbortError, ConfigurationError } from "../../core/errors";
import { getOperationArgs } from "../../core/metadata";
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
    const metrics = createCacheMetrics(services);

    return {
      name: "cache",
      order: 150,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithCache(ctx, next, services, cacheOptions, entries, metrics);
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
  metrics: CacheMetrics,
): Promise<T> {
  if (ctx.signal.aborted) {
    throw createAbortError(ctx);
  }

  const lookupStartedAt = services.clock.now();
  const key = resolveKey(options, ctx);
  const keyType = getKeyType(key);
  const labels = createMetricLabels(ctx);
  const now = services.clock.now();
  const entry = entries.get(key);

  if (entry !== undefined) {
    if (!isExpired(entry, now)) {
      recordHit(ctx, services, metrics, labels, keyType, entry, lookupStartedAt, now);

      return entry.value as T;
    }

    entries.delete(key);
    recordExpired(ctx, services, metrics, labels, keyType, entry, entries.size, now);
    recordMiss(ctx, services, metrics, labels, keyType, "expired", lookupStartedAt, now);
  } else {
    recordMiss(ctx, services, metrics, labels, keyType, "absent", lookupStartedAt, now);
  }

  const value = await next(ctx);
  const valueType = getValueType(value);

  if (shouldCacheValue(value, options)) {
    storeValue(
      entries,
      key,
      keyType,
      value,
      services.clock.now(),
      ctx,
      services,
      options,
      metrics,
      labels,
    );
  } else {
    recordSkipped(ctx, services, metrics, labels, keyType, valueType, skipReason(value));
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
  keyType: CacheEventKeyType,
  value: unknown,
  now: number,
  ctx: Context,
  services: PolicyServices,
  options: NormalizedCacheOptions,
  metrics: CacheMetrics,
  labels: Labels,
): void {
  const replacedExisting = entries.has(key);

  if (replacedExisting) {
    entries.delete(key);
  }

  removeExpiredEntriesDuringCleanup(entries, now, ctx, services, metrics, labels);

  while (entries.size >= options.maxEntries) {
    const oldestKey = entries.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    entries.delete(oldestKey);
    recordEvicted(ctx, services, metrics, labels, getKeyType(oldestKey), "capacity", entries.size);
  }

  entries.set(
    key,
    Object.freeze({
      value,
      createdAt: now,
      expiresAt: resolveExpiresAt(now, options.ttl),
    }),
  );
  recordStored(
    ctx,
    services,
    metrics,
    labels,
    keyType,
    value,
    options.ttl,
    replacedExisting,
    entries.size,
  );
}

function removeExpiredEntriesDuringCleanup(
  entries: Map<DedupeKey, CacheEntry<unknown>>,
  now: number,
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
): void {
  for (const [key, entry] of entries) {
    if (isExpired(entry, now)) {
      entries.delete(key);
      recordEvicted(
        ctx,
        services,
        metrics,
        labels,
        getKeyType(key),
        "expired-cleanup",
        entries.size,
      );
    }
  }
}

function resolveExpiresAt(createdAt: number, ttl: number): number {
  const expiresAt = createdAt + ttl;

  return Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
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

type CacheMissReason = "absent" | "expired";
type CacheSkipReason = "null-disabled" | "undefined-disabled";
type CacheEvictionReason = "capacity" | "expired-cleanup";
type CacheMetricSkipReason = "null_disabled" | "undefined_disabled";
type CacheLookupResult = "hit" | "miss_absent" | "miss_expired";

interface CacheMetrics {
  readonly hitsTotal: Counter;
  readonly missesTotal: Counter;
  readonly storesTotal: Counter;
  readonly skippedTotal: Counter;
  readonly expiredTotal: Counter;
  readonly evictionsTotal: Counter;
  readonly entries: Gauge;
  readonly lookupDurationMs: Histogram;
}

function recordHit(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  entry: CacheEntry<unknown>,
  lookupStartedAt: number,
  now: number,
): void {
  const ageMs = elapsedMs(now, entry.createdAt);
  const remainingTtlMs = Math.max(0, entry.expiresAt - now);

  safeRecordCounter(metrics.hitsTotal, 1, labels);
  recordLookupDuration(metrics, labels, "hit", lookupStartedAt, now);
  services.emit({
    ...eventBase("CacheHit", ctx, now),
    keyType,
    ageMs,
    remainingTtlMs,
    valueType: getValueType(entry.value),
  });
}

function recordMiss(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  reason: CacheMissReason,
  lookupStartedAt: number,
  now: number,
): void {
  safeRecordCounter(metrics.missesTotal, 1, {
    ...labels,
    reason,
  });
  recordLookupDuration(
    metrics,
    labels,
    reason === "absent" ? "miss_absent" : "miss_expired",
    lookupStartedAt,
    now,
  );
  services.emit({
    ...eventBase("CacheMiss", ctx, now),
    keyType,
    reason,
  });
}

function recordStored(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  value: unknown,
  ttlMs: number,
  replacedExisting: boolean,
  cacheSize: number,
): void {
  const valueType = getValueType(value);

  safeRecordCounter(metrics.storesTotal, 1, {
    ...labels,
    value_type: valueType,
  });
  safeSetGauge(metrics.entries, cacheSize, labels);
  services.emit({
    ...eventBase("CacheStored", ctx, services.clock.now()),
    keyType,
    ttlMs,
    valueType,
    replacedExisting,
    cacheSize,
  });
}

function recordExpired(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  entry: CacheEntry<unknown>,
  cacheSizeAfterRemoval: number,
  now: number,
): void {
  safeRecordCounter(metrics.expiredTotal, 1, labels);
  safeSetGauge(metrics.entries, cacheSizeAfterRemoval, labels);
  services.emit({
    ...eventBase("CacheExpired", ctx, now),
    keyType,
    ageMs: elapsedMs(now, entry.createdAt),
    expiredByMs: Math.max(0, now - entry.expiresAt),
    cacheSizeAfterRemoval,
  });
}

function recordEvicted(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  reason: CacheEvictionReason,
  cacheSizeAfterRemoval: number,
): void {
  safeRecordCounter(metrics.evictionsTotal, 1, {
    ...labels,
    reason: reason === "expired-cleanup" ? "expired_cleanup" : "capacity",
  });
  safeSetGauge(metrics.entries, cacheSizeAfterRemoval, labels);
  services.emit({
    ...eventBase("CacheEvicted", ctx, services.clock.now()),
    reason,
    keyType,
    cacheSizeAfterRemoval,
  });
}

function recordSkipped(
  ctx: Context,
  services: PolicyServices,
  metrics: CacheMetrics,
  labels: Labels,
  keyType: CacheEventKeyType,
  valueType: CacheEventValueType,
  reason: CacheSkipReason,
): void {
  safeRecordCounter(metrics.skippedTotal, 1, {
    ...labels,
    reason: metricSkipReason(reason),
  });
  services.emit({
    ...eventBase("CacheSkipped", ctx, services.clock.now()),
    reason,
    keyType,
    valueType,
  });
}

function recordLookupDuration(
  metrics: CacheMetrics,
  labels: Labels,
  result: CacheLookupResult,
  lookupStartedAt: number,
  now: number,
): void {
  safeRecordHistogram(metrics.lookupDurationMs, elapsedMs(now, lookupStartedAt), {
    ...labels,
    result,
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

function getKeyType(key: DedupeKey): CacheEventKeyType {
  if (typeof key === "string") {
    return "string";
  }

  if (typeof key === "number") {
    return "number";
  }

  return "symbol";
}

function getValueType(value: unknown): CacheEventValueType {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  return typeof value === "object" || typeof value === "function" ? "object" : "primitive";
}

function skipReason(value: unknown): CacheSkipReason {
  return value === null ? "null-disabled" : "undefined-disabled";
}

function metricSkipReason(reason: CacheSkipReason): CacheMetricSkipReason {
  return reason === "null-disabled" ? "null_disabled" : "undefined_disabled";
}

function createMetricLabels(ctx: Context): Labels {
  return Object.freeze({
    service: ctx.serviceName,
    operation: ctx.operationName,
  });
}

function elapsedMs(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

function createCacheMetrics(services: PolicyServices): CacheMetrics {
  return Object.freeze({
    hitsTotal: safeCounter(
      services,
      "resili_cache_hits_total",
      "Memory cache hits returned without downstream execution.",
    ),
    missesTotal: safeCounter(
      services,
      "resili_cache_misses_total",
      "Memory cache misses that executed downstream.",
    ),
    storesTotal: safeCounter(
      services,
      "resili_cache_stores_total",
      "Memory cache successful values stored.",
    ),
    skippedTotal: safeCounter(
      services,
      "resili_cache_skipped_total",
      "Memory cache successful values intentionally not stored.",
    ),
    expiredTotal: safeCounter(
      services,
      "resili_cache_expired_total",
      "Memory cache entries removed during lookup because they expired.",
    ),
    evictionsTotal: safeCounter(
      services,
      "resili_cache_evictions_total",
      "Memory cache entries evicted while enforcing capacity.",
    ),
    entries: safeGauge(services, "resili_cache_entries", "Current memory cache entry count."),
    lookupDurationMs: safeHistogram(
      services,
      "resili_cache_lookup_duration_ms",
      "Memory cache lookup duration in milliseconds.",
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
