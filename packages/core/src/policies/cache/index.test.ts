import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { createContext, releaseContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { AbortError, ConfigurationError } from "../../core/errors";
import {
  noopMetrics,
  type Counter,
  type Gauge,
  type Histogram,
  type Labels,
  type MetricsRecorder,
} from "../../core/metrics";
import { OPERATION_ARGS_METADATA_KEY } from "../../core/metadata";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import type { DedupeKey } from "../dedupe";
import { cachePolicy } from "./index";
import type { Clock } from "../../core/clock";

describe("cachePolicy", () => {
  it("creates an immutable policy and executes downstream on miss", async () => {
    const policy = cachePolicy.create(createServices(), { key: () => "user:42", ttl: 100 });
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));

    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok");
    expect(cachePolicy.name).toBe("cache");
    expect(cachePolicy.order).toBe(150);
    expect(policy.name).toBe("cache");
    expect(policy.order).toBe(150);
    expect(Object.isFrozen(cachePolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid options with field paths", () => {
    const services = createServices();

    expectConfigurationField(() => cachePolicy.create(services), "cache");
    expectConfigurationField(() => cachePolicy.create(services, null), "cache");
    expectConfigurationField(() => cachePolicy.create(services, []), "cache");
    expectConfigurationField(() => cachePolicy.create(services, {}), "cache.key");
    expectConfigurationField(() => cachePolicy.create(services, { key: "user:42" }), "cache.key");
    expectConfigurationField(() => cachePolicy.create(services, { key: () => "key" }), "cache.ttl");

    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
      expectConfigurationField(
        () => cachePolicy.create(services, { key: () => "key", ttl }),
        "cache.ttl",
      );
    }

    expectConfigurationField(
      () => cachePolicy.create(services, { key: () => "key", ttl: 100, cacheNull: "yes" }),
      "cache.cacheNull",
    );
    expectConfigurationField(
      () => cachePolicy.create(services, { key: () => "key", ttl: 100, cacheUndefined: "yes" }),
      "cache.cacheUndefined",
    );

    for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
      expectConfigurationField(
        () => cachePolicy.create(services, { key: () => "key", ttl: 100, maxEntries }),
        "cache.maxEntries",
      );
    }
  });

  it("accepts default and explicit maxEntries values", async () => {
    const defaultPolicy = cachePolicy.create(createServices(), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 100,
    });
    let defaultCalls = 0;

    for (let index = 0; index <= 1_000; index += 1) {
      await defaultPolicy.execute(createTestContext({ args: [index] }), () => {
        defaultCalls += 1;

        return Promise.resolve(index);
      });
    }

    await expect(
      defaultPolicy.execute(createTestContext({ args: [0] }), () => {
        defaultCalls += 1;

        return Promise.resolve("evicted");
      }),
    ).resolves.toBe("evicted");
    expect(defaultCalls).toBe(1_002);

    const explicitPolicy = cachePolicy.create(createServices(), {
      key: () => "key",
      ttl: 100,
      maxEntries: 1,
    });

    await expect(
      explicitPolicy.execute(createTestContext(), () => Promise.resolve("ok")),
    ).resolves.toBe("ok");
  });

  it("accepts string, finite number, and symbol keys", async () => {
    const symbolKey = Symbol("user");
    const keys: DedupeKey[] = ["user:42", 42, symbolKey];
    const policy = cachePolicy.create(createServices(), {
      key: () => keys.shift() ?? "fallback",
      ttl: 100,
    });

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("string")),
    ).resolves.toBe("string");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("number")),
    ).resolves.toBe("number");
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("symbol")),
    ).resolves.toBe("symbol");
  });

  it("rejects invalid key results and never invokes downstream", async () => {
    const invalidKeys: readonly unknown[] = [
      undefined,
      null,
      {},
      [],
      () => "key",
      1n,
      true,
      false,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const invalidKey of invalidKeys) {
      const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));
      const policy = cachePolicy.create(createServices(), { key: () => invalidKey, ttl: 100 });

      await expect(policy.execute(createTestContext(), next)).rejects.toMatchObject({
        field: "cache.key",
      });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("propagates key function throws without invoking downstream", async () => {
    const failure = new Error("key failed");
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));
    const policy = cachePolicy.create(createServices(), {
      key() {
        throw failure;
      },
      ttl: 100,
    });

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(failure);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes operation arguments from context metadata to the key function", async () => {
    const key = vi.fn(
      (tenantId: unknown, userId: unknown) => `${String(tenantId)}:${String(userId)}`,
    );
    const policy = cachePolicy.create(createServices(), { key, ttl: 100 });

    await expect(
      policy.execute(createTestContext({ args: ["tenant", "42"] }), () => Promise.resolve("ok")),
    ).resolves.toBe("ok");

    expect(key).toHaveBeenCalledWith("tenant", "42");
    expect(key).toHaveBeenCalledTimes(1);
  });

  it("stores successful results and returns hits without downstream execution", async () => {
    const policy = cachePolicy.create(createServices(), { key: () => "user:42", ttl: 100 });
    const next = vi.fn<Next<{ readonly id: string }>>(() => Promise.resolve({ id: "42" }));

    const first = await policy.execute(createTestContext(), next);
    const second = await policy.execute(createTestContext(), next);

    expect(second).toBe(first);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys isolated", async () => {
    const policy = cachePolicy.create(createServices(), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 100,
    });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:1");
    await expect(policy.execute(createTestContext({ args: ["b"] }), next)).resolves.toBe("value:2");
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:1");
    expect(calls).toBe(2);
  });

  it("expires entries at the exact TTL boundary using the injected clock", async () => {
    const clock = new ManualClock();
    const policy = cachePolicy.create(createServices({ clock }), { key: () => "key", ttl: 10 });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await expect(policy.execute(createTestContext(), next)).resolves.toBe("value:1");
    clock.tick(9);
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("value:1");
    clock.tick(1);
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("value:2");
    expect(calls).toBe(2);
  });

  it("does not incorrectly expire when the injected clock moves backward", async () => {
    const clock = new ManualClock(10);
    const policy = cachePolicy.create(createServices({ clock }), { key: () => "key", ttl: 10 });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await expect(policy.execute(createTestContext(), next)).resolves.toBe("value:1");
    clock.set(5);
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("value:1");
    expect(calls).toBe(1);
  });

  it("does not cache failures or rejected promises", async () => {
    const policy = cachePolicy.create(createServices(), { key: () => "key", ttl: 100 });
    let calls = 0;
    const firstFailure = new Error("failed:1");
    const next: Next<string> = () => {
      calls += 1;

      return calls === 1 ? Promise.reject(firstFailure) : Promise.resolve(`ok:${String(calls)}`);
    };

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(firstFailure);
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok:2");
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok:2");
    expect(calls).toBe(2);
  });

  it("applies null and undefined cacheability options", async () => {
    await expectValueNotCached(null, { cacheNull: false });
    await expectValueCached(null, { cacheNull: true });
    await expectValueNotCached(undefined, { cacheUndefined: false });
    await expectValueCached(undefined, { cacheUndefined: true });
  });

  it("caches ordinary falsy values by default", async () => {
    for (const value of [false, 0, ""]) {
      const policy = cachePolicy.create(createServices(), { key: () => "key", ttl: 100 });
      const next = vi.fn<Next<typeof value>>(() => Promise.resolve(value));

      await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
      await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("evicts oldest inserted entries without LRU updates", async () => {
    const policy = cachePolicy.create(createServices(), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 100,
      maxEntries: 2,
    });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await policy.execute(createTestContext({ args: ["a"] }), next);
    await policy.execute(createTestContext({ args: ["b"] }), next);
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:1");
    await policy.execute(createTestContext({ args: ["c"] }), next);
    await expect(policy.execute(createTestContext({ args: ["b"] }), next)).resolves.toBe("value:2");
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:4");
    expect(calls).toBe(4);
  });

  it("moves replaced entries to the newest FIFO position", async () => {
    const clock = new ManualClock();
    const policy = cachePolicy.create(createServices({ clock }), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 5,
      maxEntries: 2,
    });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await policy.execute(createTestContext({ args: ["a"] }), next);
    await policy.execute(createTestContext({ args: ["b"] }), next);
    clock.tick(5);
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:3");
    await policy.execute(createTestContext({ args: ["c"] }), next);
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:3");
    await expect(policy.execute(createTestContext({ args: ["b"] }), next)).resolves.toBe("value:5");
    expect(calls).toBe(5);
  });

  it("removes expired entries before live FIFO eviction", async () => {
    const clock = new ManualClock();
    const policy = cachePolicy.create(createServices({ clock }), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 5,
      maxEntries: 2,
    });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await policy.execute(createTestContext({ args: ["a"] }), next);
    clock.tick(5);
    await policy.execute(createTestContext({ args: ["b"] }), next);
    await policy.execute(createTestContext({ args: ["c"] }), next);
    await expect(policy.execute(createTestContext({ args: ["b"] }), next)).resolves.toBe("value:2");
    expect(calls).toBe(3);
  });

  it("enforces maxEntries one", async () => {
    const policy = cachePolicy.create(createServices(), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 100,
      maxEntries: 1,
    });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`value:${String(calls)}`);
    };

    await policy.execute(createTestContext({ args: ["a"] }), next);
    await policy.execute(createTestContext({ args: ["b"] }), next);
    await expect(policy.execute(createTestContext({ args: ["a"] }), next)).resolves.toBe("value:3");
    expect(calls).toBe(3);
  });

  it("does not create timers or listeners", async () => {
    const clock = new ManualClock();
    const context = createTestContext();
    const addListener = vi.spyOn(context.signal, "addEventListener");
    const removeListener = vi.spyOn(context.signal, "removeEventListener");
    const policy = cachePolicy.create(createServices({ clock }), { key: () => "key", ttl: 100 });

    await expect(policy.execute(context, () => Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(policy.execute(context, () => Promise.resolve("unused"))).resolves.toBe("ok");

    expect(clock.setTimeoutCalls).toBe(0);
    expect(clock.clearTimeoutCalls).toBe(0);
    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    releaseContext(context);
  });

  it("rejects already-aborted contexts before key resolution or downstream execution", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const key = vi.fn(() => "key");
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));
    const policy = cachePolicy.create(createServices(), { key, ttl: 100 });
    const context = createTestContext({ signal: controller.signal });

    await expect(policy.execute(context, next)).rejects.toBe(reason);
    expect(key).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    releaseContext(context);
  });

  it("uses AbortError for already-aborted contexts without an Error reason", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const policy = cachePolicy.create(createServices(), { key: () => "key", ttl: 100 });
    const context = createTestContext({ signal: controller.signal });

    await expect(policy.execute(context, () => Promise.resolve("ok"))).rejects.toBeInstanceOf(
      AbortError,
    );
    releaseContext(context);
  });

  it("passes the original context downstream on miss without mutating metadata", async () => {
    const args = ["tenant", "42"] as const;
    const context = createTestContext({ args, attemptNumber: 3, metadata: { tenant: "acme" } });
    const policy = cachePolicy.create(createServices(), {
      key: (tenantId: unknown, userId: unknown) => `${String(tenantId)}:${String(userId)}`,
      ttl: 100,
    });
    let observedContext: Context | undefined;

    await expect(
      policy.execute(context, (ctx) => {
        observedContext = ctx;

        return Promise.resolve("ok");
      }),
    ).resolves.toBe("ok");

    expect(observedContext).toBe(context);
    expect(observedContext?.attemptNumber).toBe(3);
    expect(context.metadata.get("tenant")).toBe("acme");
    expect(context.metadata.get(OPERATION_ARGS_METADATA_KEY)).toBe(args);
    releaseContext(context);
  });

  it("does not share concurrent misses through in-flight promises", async () => {
    const policy = cachePolicy.create(createServices(), { key: () => "key", ttl: 100 });
    const firstGate = createGate<string>();
    const secondGate = createGate<string>();
    const gates = [firstGate, secondGate];
    const next = vi.fn<Next<string>>(() => gates.shift()?.promise ?? Promise.resolve("extra"));
    const first = policy.execute(createTestContext(), next);
    const second = policy.execute(createTestContext(), next);

    expect(next).toHaveBeenCalledTimes(2);
    firstGate.resolve("first");
    secondGate.resolve("second");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("emits deterministic hit, miss, stored, expired, skipped, and eviction events", async () => {
    const events: ResiliEvent[] = [];
    const clock = new ManualClock();
    const policy = cachePolicy.create(
      createServices({
        clock,
        emit: (event) => events.push(event),
      }),
      {
        key: (key: unknown) => key as DedupeKey,
        ttl: 10,
        cacheNull: false,
        maxEntries: 2,
      },
    );

    await policy.execute(createTestContext({ args: ["secret-a"] }), () =>
      Promise.resolve({ ok: true }),
    );
    clock.tick(4);
    await policy.execute(createTestContext({ args: ["secret-a"] }), () =>
      Promise.resolve("unused"),
    );
    clock.tick(6);
    await policy.execute(createTestContext({ args: ["secret-a"] }), () => Promise.resolve("new-a"));
    await policy.execute(createTestContext({ args: ["secret-null"] }), () => Promise.resolve(null));
    await policy.execute(createTestContext({ args: ["secret-b"] }), () => Promise.resolve("b"));
    await policy.execute(createTestContext({ args: ["secret-c"] }), () => Promise.resolve("c"));

    expect(events.map((event) => event.type)).toEqual([
      "CacheMiss",
      "CacheStored",
      "CacheHit",
      "CacheExpired",
      "CacheMiss",
      "CacheStored",
      "CacheMiss",
      "CacheSkipped",
      "CacheMiss",
      "CacheStored",
      "CacheMiss",
      "CacheEvicted",
      "CacheStored",
    ]);
    expect(events[0]).toMatchObject({ type: "CacheMiss", keyType: "string", reason: "absent" });
    expect(events[1]).toMatchObject({
      type: "CacheStored",
      keyType: "string",
      ttlMs: 10,
      valueType: "object",
      replacedExisting: false,
      cacheSize: 1,
    });
    expect(events[2]).toMatchObject({
      type: "CacheHit",
      ageMs: 4,
      remainingTtlMs: 6,
      valueType: "object",
    });
    expect(events[3]).toMatchObject({
      type: "CacheExpired",
      ageMs: 10,
      expiredByMs: 0,
      cacheSizeAfterRemoval: 0,
    });
    expect(events[4]).toMatchObject({ type: "CacheMiss", reason: "expired" });
    expect(events[7]).toMatchObject({
      type: "CacheSkipped",
      reason: "null-disabled",
      valueType: "null",
    });
    expect(events[11]).toMatchObject({
      type: "CacheEvicted",
      reason: "capacity",
      cacheSizeAfterRemoval: 1,
    });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("emits undefined skipped and replacement stored events", async () => {
    const events: ResiliEvent[] = [];
    const firstGate = createGate<string>();
    const secondGate = createGate<string>();
    const gates = [firstGate, secondGate];
    const policy = cachePolicy.create(createServices({ emit: (event) => events.push(event) }), {
      key: () => "secret-key",
      ttl: 100,
    });
    const first = policy.execute(
      createTestContext(),
      () => gates.shift()?.promise ?? Promise.resolve("extra"),
    );
    const second = policy.execute(
      createTestContext(),
      () => gates.shift()?.promise ?? Promise.resolve("extra"),
    );

    firstGate.resolve("first");
    secondGate.resolve("second");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");

    const skipped = cachePolicy.create(createServices({ emit: (event) => events.push(event) }), {
      key: () => "undefined-key",
      ttl: 100,
    });
    await skipped.execute(createTestContext(), () => Promise.resolve(undefined));

    expect(events.filter((event) => event.type === "CacheStored")).toEqual([
      expect.objectContaining({ type: "CacheStored", replacedExisting: false, cacheSize: 1 }),
      expect.objectContaining({ type: "CacheStored", replacedExisting: true, cacheSize: 1 }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "CacheSkipped",
        reason: "undefined-disabled",
        valueType: "undefined",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("records low-cardinality metrics for cache lifecycle", async () => {
    const metrics = new RecordingMetrics();
    const clock = new ManualClock();
    const policy = cachePolicy.create(createServices({ clock, metrics }), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 10,
      maxEntries: 2,
    });

    await policy.execute(createTestContext({ args: ["a"] }), () => Promise.resolve("a"));
    clock.tick(5);
    await policy.execute(createTestContext({ args: ["a"] }), () => Promise.resolve("unused"));
    clock.tick(5);
    await policy.execute(createTestContext({ args: ["a"] }), () => Promise.resolve(null));
    await policy.execute(createTestContext({ args: ["b"] }), () => Promise.resolve(1));
    await policy.execute(createTestContext({ args: ["c"] }), () =>
      Promise.resolve(() => undefined),
    );
    await policy.execute(createTestContext({ args: ["d"] }), () => Promise.resolve("d"));

    expect(metrics.counterValue("resili_cache_hits_total", baseLabels())).toBe(1);
    expect(
      metrics.counterValue("resili_cache_misses_total", { ...baseLabels(), reason: "absent" }),
    ).toBe(4);
    expect(
      metrics.counterValue("resili_cache_misses_total", { ...baseLabels(), reason: "expired" }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_cache_stores_total", {
        ...baseLabels(),
        value_type: "primitive",
      }),
    ).toBe(3);
    expect(
      metrics.counterValue("resili_cache_stores_total", { ...baseLabels(), value_type: "object" }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_cache_skipped_total", {
        ...baseLabels(),
        reason: "null_disabled",
      }),
    ).toBe(1);
    expect(metrics.counterValue("resili_cache_expired_total", baseLabels())).toBe(1);
    expect(
      metrics.counterValue("resili_cache_evictions_total", { ...baseLabels(), reason: "capacity" }),
    ).toBe(1);
    expect(metrics.gaugeValue("resili_cache_entries", baseLabels())).toBe(2);
    expect(
      metrics.histogramValues("resili_cache_lookup_duration_ms", {
        ...baseLabels(),
        result: "hit",
      }),
    ).toEqual([0]);
    expect(
      metrics.histogramValues("resili_cache_lookup_duration_ms", {
        ...baseLabels(),
        result: "miss_absent",
      }),
    ).toEqual([0, 0, 0, 0]);
    expect(
      metrics.histogramValues("resili_cache_lookup_duration_ms", {
        ...baseLabels(),
        result: "miss_expired",
      }),
    ).toEqual([0]);
    expect(metrics.labels()).not.toContain("secret");
    expect(metrics.labels()).not.toContain("request");
  });

  it("classifies expired capacity cleanup without double-counting expired removals", async () => {
    const metrics = new RecordingMetrics();
    const events: ResiliEvent[] = [];
    const clock = new ManualClock();
    const policy = cachePolicy.create(
      createServices({ clock, metrics, emit: (event) => events.push(event) }),
      {
        key: (key: unknown) => key as DedupeKey,
        ttl: 5,
        maxEntries: 3,
      },
    );

    await policy.execute(createTestContext({ args: ["a"] }), () => Promise.resolve("a"));
    await policy.execute(createTestContext({ args: ["b"] }), () => Promise.resolve("b"));
    clock.tick(5);
    await policy.execute(createTestContext({ args: ["c"] }), () => Promise.resolve("c"));

    expect(events.filter((event) => event.type === "CacheExpired")).toHaveLength(0);
    expect(events.filter((event) => event.type === "CacheEvicted")).toEqual([
      expect.objectContaining({
        type: "CacheEvicted",
        reason: "expired-cleanup",
        cacheSizeAfterRemoval: 1,
      }),
      expect.objectContaining({
        type: "CacheEvicted",
        reason: "expired-cleanup",
        cacheSizeAfterRemoval: 0,
      }),
    ]);
    expect(metrics.counterValue("resili_cache_expired_total", baseLabels())).toBe(0);
    expect(
      metrics.counterValue("resili_cache_evictions_total", {
        ...baseLabels(),
        reason: "expired_cleanup",
      }),
    ).toBe(2);
    expect(metrics.gaugeValue("resili_cache_entries", baseLabels())).toBe(1);
  });

  it("keeps gauge stable for replacement at capacity", async () => {
    const metrics = new RecordingMetrics();
    const firstGate = createGate<string>();
    const secondGate = createGate<string>();
    const gates = [firstGate, secondGate];
    const policy = cachePolicy.create(createServices({ metrics }), {
      key: (key: unknown) => key as DedupeKey,
      ttl: 100,
      maxEntries: 1,
    });
    const first = policy.execute(
      createTestContext({ args: ["a"] }),
      () => gates.shift()?.promise ?? Promise.resolve("extra"),
    );
    const second = policy.execute(
      createTestContext({ args: ["a"] }),
      () => gates.shift()?.promise ?? Promise.resolve("extra"),
    );

    firstGate.resolve("first");
    secondGate.resolve("second");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");

    expect(
      metrics.counterValue("resili_cache_evictions_total", { ...baseLabels(), reason: "capacity" }),
    ).toBe(0);
    expect(metrics.gaugeValue("resili_cache_entries", baseLabels())).toBe(1);
  });

  it("isolates metric recording failures without changing results", async () => {
    const policy = cachePolicy.create(createServices({ metrics: new ThrowingMetrics() }), {
      key: () => "key",
      ttl: 100,
    });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("unused")),
    ).resolves.toBe("ok");
  });

  it("handles TTL overflow deterministically", async () => {
    const clock = new ManualClock(Number.MAX_VALUE);
    const policy = cachePolicy.create(createServices({ clock }), {
      key: () => "key",
      ttl: Number.MAX_VALUE,
    });
    let calls = 0;

    await policy.execute(createTestContext(), () => {
      calls += 1;

      return Promise.resolve("ok");
    });
    clock.set(Number.MAX_VALUE);
    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("unused")),
    ).resolves.toBe("ok");
    expect(calls).toBe(1);
  });
});

async function expectValueCached(
  value: unknown,
  options: { readonly cacheNull?: boolean; readonly cacheUndefined?: boolean },
): Promise<void> {
  const policy = cachePolicy.create(createServices(), {
    key: () => "key",
    ttl: 100,
    ...options,
  });
  const next = vi.fn<Next<unknown>>(() => Promise.resolve(value));

  await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
  await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
  expect(next).toHaveBeenCalledTimes(1);
}

async function expectValueNotCached(
  value: unknown,
  options: { readonly cacheNull?: boolean; readonly cacheUndefined?: boolean },
): Promise<void> {
  const policy = cachePolicy.create(createServices(), {
    key: () => "key",
    ttl: 100,
    ...options,
  });
  const next = vi.fn<Next<unknown>>(() => Promise.resolve(value));

  await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
  await expect(policy.execute(createTestContext(), next)).resolves.toBe(value);
  expect(next).toHaveBeenCalledTimes(2);
}

function expectConfigurationField(action: () => unknown, field: string): void {
  expect(action).toThrow(ConfigurationError);

  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ field });
  }
}

function createTestContext(
  options: {
    readonly args?: readonly unknown[];
    readonly attemptNumber?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  } = {},
): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    attemptNumber: options.attemptNumber,
    metadata: {
      ...(options.metadata ?? {}),
      ...(options.args === undefined ? {} : { [OPERATION_ARGS_METADATA_KEY]: options.args }),
    },
    signal: options.signal,
    startedAt: 0,
  });
}

function createServices(overrides: Partial<PolicyServices> = {}): PolicyServices {
  return {
    clock: new ManualClock(),
    metrics: noopMetrics,
    emit() {
      // Cache Phase 1 intentionally emits no events.
    },
    store: memoryStore(),
    classifier: httpClassifier,
    ...overrides,
  };
}

function baseLabels(): Labels {
  return Object.freeze({
    service: "service",
    operation: "operation",
  });
}

class ManualClock implements Clock {
  setTimeoutCalls = 0;
  clearTimeoutCalls = 0;
  #now: number;

  constructor(now = 0) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  set(now: number): void {
    this.#now = now;
  }

  tick(ms: number): void {
    this.#now += ms;
  }

  setTimeout(): ReturnType<typeof globalThis.setTimeout> {
    this.setTimeoutCalls += 1;

    return 0 as ReturnType<typeof globalThis.setTimeout>;
  }

  clearTimeout(): void {
    this.clearTimeoutCalls += 1;
  }
}

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

class RecordingMetrics implements MetricsRecorder {
  readonly #counters = new Map<string, RecordingCounter>();
  readonly #gauges = new Map<string, RecordingGauge>();
  readonly #histograms = new Map<string, RecordingHistogram>();

  counter(name: string): Counter {
    let counter = this.#counters.get(name);

    if (counter === undefined) {
      counter = new RecordingCounter();
      this.#counters.set(name, counter);
    }

    return counter;
  }

  gauge(name: string): Gauge {
    let gauge = this.#gauges.get(name);

    if (gauge === undefined) {
      gauge = new RecordingGauge();
      this.#gauges.set(name, gauge);
    }

    return gauge;
  }

  histogram(name: string): Histogram {
    let histogram = this.#histograms.get(name);

    if (histogram === undefined) {
      histogram = new RecordingHistogram();
      this.#histograms.set(name, histogram);
    }

    return histogram;
  }

  counterValue(name: string, labels?: Labels): number {
    return this.#counters.get(name)?.value(labels) ?? 0;
  }

  gaugeValue(name: string, labels?: Labels): number | undefined {
    return this.#gauges.get(name)?.value(labels);
  }

  histogramValues(name: string, labels?: Labels): readonly number[] {
    return this.#histograms.get(name)?.values(labels) ?? [];
  }

  labels(): string {
    return [
      ...[...this.#counters.values()].flatMap((counter) => counter.labels()),
      ...[...this.#gauges.values()].flatMap((gauge) => gauge.labels()),
      ...[...this.#histograms.values()].flatMap((histogram) => histogram.labels()),
    ].join("\n");
  }
}

class RecordingCounter implements Counter {
  readonly #values = new Map<string, number>();

  add(value: number, labels?: Labels): void {
    const key = labelsKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  value(labels?: Labels): number {
    return this.#values.get(labelsKey(labels)) ?? 0;
  }

  labels(): string[] {
    return [...this.#values.keys()];
  }
}

class RecordingGauge implements Gauge {
  readonly #values = new Map<string, number>();

  set(value: number, labels?: Labels): void {
    this.#values.set(labelsKey(labels), value);
  }

  value(labels?: Labels): number | undefined {
    return this.#values.get(labelsKey(labels));
  }

  labels(): string[] {
    return [...this.#values.keys()];
  }
}

class RecordingHistogram implements Histogram {
  readonly #values = new Map<string, number[]>();

  record(value: number, labels?: Labels): void {
    const key = labelsKey(labels);
    const values = this.#values.get(key);

    if (values === undefined) {
      this.#values.set(key, [value]);
      return;
    }

    values.push(value);
  }

  values(labels?: Labels): readonly number[] {
    return this.#values.get(labelsKey(labels)) ?? [];
  }

  labels(): string[] {
    return [...this.#values.keys()];
  }
}

class ThrowingMetrics implements MetricsRecorder {
  counter(): Counter {
    return {
      add(): void {
        throw new Error("counter failed");
      },
    };
  }

  gauge(): Gauge {
    return {
      set(): void {
        throw new Error("gauge failed");
      },
    };
  }

  histogram(): Histogram {
    return {
      record(): void {
        throw new Error("histogram failed");
      },
    };
  }
}

function labelsKey(labels: Labels | undefined): string {
  if (labels === undefined) {
    return "";
  }

  return Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000");
}
