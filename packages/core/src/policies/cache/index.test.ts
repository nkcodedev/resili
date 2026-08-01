import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { createContext, releaseContext, type Context } from "../../core/context";
import { AbortError, ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
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
