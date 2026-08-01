import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { systemClock } from "../../core/clock";
import { createContext, releaseContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError } from "../../core/errors";
import { noopMetrics } from "../../core/metrics";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { dedupePolicy, type DedupeKey } from "./index";

describe("dedupePolicy", () => {
  it("creates an immutable policy from valid options", () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });

    expect(dedupePolicy.name).toBe("dedupe");
    expect(dedupePolicy.order).toBe(425);
    expect(policy.name).toBe("dedupe");
    expect(policy.order).toBe(425);
    expect(Object.isFrozen(dedupePolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects missing and invalid options with field paths", () => {
    const services = createServices();

    expectConfigurationField(() => dedupePolicy.create(services), "dedupe");
    expectConfigurationField(() => dedupePolicy.create(services, {}), "dedupe.key");
    expectConfigurationField(() => dedupePolicy.create(services, { key: "user:42" }), "dedupe.key");
    expectConfigurationField(
      () => dedupePolicy.create(services, { key: () => "user:42", abortSharedWhenUnused: "yes" }),
      "dedupe.abortSharedWhenUnused",
    );
  });

  it("accepts default and explicit abortSharedWhenUnused values", async () => {
    const defaultPolicy = dedupePolicy.create(createServices(), { key: () => "default" });
    const falsePolicy = dedupePolicy.create(createServices(), {
      key: () => "false",
      abortSharedWhenUnused: false,
    });

    await expect(
      defaultPolicy.execute(createTestContext(), () => Promise.resolve("ok")),
    ).resolves.toBe("ok");
    await expect(
      falsePolicy.execute(createTestContext(), () => Promise.resolve("ok")),
    ).resolves.toBe("ok");
  });

  it("accepts string, finite number, and symbol keys", async () => {
    const symbolKey = Symbol("user");
    const keys: DedupeKey[] = ["user:42", 42, symbolKey];
    const policy = dedupePolicy.create(createServices(), {
      key: () => keys.shift() ?? "fallback",
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
      const policy = dedupePolicy.create(createServices(), { key: () => invalidKey });

      await expect(policy.execute(createTestContext(), next)).rejects.toMatchObject({
        field: "dedupe.key",
      });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("propagates key function throws without invoking downstream", async () => {
    const failure = new Error("key failed");
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));
    const policy = dedupePolicy.create(createServices(), {
      key() {
        throw failure;
      },
    });

    await expect(policy.execute(createTestContext(), next)).rejects.toBe(failure);
    expect(next).not.toHaveBeenCalled();
  });

  it("shares same-key concurrent callers through one downstream execution", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const gate = createGate<{ readonly id: string }>();
    const next = vi.fn<Next<{ readonly id: string }>>(() => gate.promise);
    const first = policy.execute(createTestContext(), next);
    const second = policy.execute(createTestContext(), next);

    expect(next).toHaveBeenCalledTimes(0);
    await flushMicrotasks();
    expect(next).toHaveBeenCalledTimes(1);

    const value = { id: "42" };
    gate.resolve(value);

    await expect(first).resolves.toBe(value);
    await expect(second).resolves.toBe(value);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("shares one downstream execution across many same-key callers", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const gate = createGate<string>();
    const next = vi.fn<Next<string>>(() => gate.promise);
    const callers = Array.from({ length: 100 }, () => policy.execute(createTestContext(), next));

    await flushMicrotasks();
    expect(next).toHaveBeenCalledTimes(1);

    gate.resolve("ok");
    await expect(Promise.all(callers)).resolves.toEqual(Array.from({ length: 100 }, () => "ok"));
  });

  it("shares same-key failures with all callers", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const failure = new Error("failed");
    const gate = createGate<string>();
    const next = vi.fn<Next<string>>(() => gate.promise);
    const first = policy.execute(createTestContext(), next);
    const second = policy.execute(createTestContext(), next);

    await flushMicrotasks();
    gate.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("executes different keys independently", async () => {
    const keys = ["user:1", "user:2"];
    const policy = dedupePolicy.create(createServices(), {
      key: () => keys.shift() ?? "fallback",
    });
    const gates = [createGate<string>(), createGate<string>()];
    let calls = 0;
    const next = vi.fn<Next<string>>(() => {
      const gate = gates[calls];
      calls += 1;

      return gate?.promise ?? Promise.resolve("extra");
    });
    const first = policy.execute(createTestContext(), next);
    const second = policy.execute(createTestContext(), next);

    await flushMicrotasks();
    expect(next).toHaveBeenCalledTimes(2);

    gates[0]?.resolve("one");
    gates[1]?.resolve("two");

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
  });

  it("does not retain completed successful results", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.resolve(`ok:${String(calls)}`);
    };

    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok:1");
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok:2");
    expect(calls).toBe(2);
  });

  it("does not retain completed failures", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      return Promise.reject(new Error(`failed:${String(calls)}`));
    };

    await expect(policy.execute(createTestContext(), next)).rejects.toThrow("failed:1");
    await expect(policy.execute(createTestContext(), next)).rejects.toThrow("failed:2");
    expect(calls).toBe(2);
  });

  it("inserts the entry before downstream invocation", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const gate = createGate<string>();
    let nested: Promise<string> | undefined;
    const next = vi.fn<Next<string>>(() => {
      nested = policy.execute(createTestContext(), () => Promise.resolve("nested"));

      return gate.promise;
    });
    const first = policy.execute(createTestContext(), next);

    await flushMicrotasks();
    expect(next).toHaveBeenCalledTimes(1);

    gate.resolve("owner");
    await expect(first).resolves.toBe("owner");
    await expect(nested).resolves.toBe("owner");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("removes the entry after synchronous downstream throws", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    let calls = 0;
    const next: Next<string> = () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("sync failed");
      }

      return Promise.resolve("ok");
    };

    await expect(policy.execute(createTestContext(), next)).rejects.toThrow("sync failed");
    await expect(policy.execute(createTestContext(), next)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("settles logical callers only once", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const gate = createGate<string>();
    let settlements = 0;
    const result = policy
      .execute(createTestContext(), () => gate.promise)
      .finally(() => {
        settlements += 1;
      });

    await flushMicrotasks();
    gate.resolve("ok");

    await expect(result).resolves.toBe("ok");
    await flushMicrotasks();
    expect(settlements).toBe(1);
  });

  it("uses the owner context for the shared Phase 1 execution", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const owner = createTestContext({ attemptNumber: 3, metadata: { tenant: "acme" } });
    const joiner = createTestContext({ attemptNumber: 7, metadata: { tenant: "other" } });
    const gate = createGate<string>();
    let observedContext: Context | undefined;
    const first = policy.execute(owner, (ctx) => {
      observedContext = ctx;

      return gate.promise;
    });
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    gate.resolve("ok");

    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    expect(observedContext).toBe(owner);
    expect(observedContext?.attemptNumber).toBe(3);
    expect(observedContext?.metadata.get("tenant")).toBe("acme");
    expect(joiner.metadata.get("tenant")).toBe("other");
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("reflects current owner-signal behavior for shared work", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const controller = new AbortController();
    const owner = createTestContext({ signal: controller.signal });
    const joiner = createTestContext();
    const first = policy.execute(owner, (ctx) => rejectOnAbort(ctx.signal));
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    controller.abort(new Error("owner aborted"));

    await expect(first).rejects.toThrow("owner aborted");
    await expect(second).rejects.toThrow("owner aborted");
    releaseContext(owner);
    releaseContext(joiner);
  });
});

function createServices(overrides: Partial<Pick<PolicyServices, "clock">> = {}): PolicyServices {
  return Object.freeze({
    clock: overrides.clock ?? systemClock,
    metrics: noopMetrics,
    emit(event: ResiliEvent): void {
      void event;
      // Test double.
    },
    store: memoryStore(),
    classifier: httpClassifier,
  });
}

function createTestContext(
  overrides: {
    readonly attemptNumber?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  } = {},
): Context {
  return createContext({
    requestId: "request",
    operationName: "operation",
    serviceName: "service",
    attemptNumber: overrides.attemptNumber,
    metadata: overrides.metadata,
    signal: overrides.signal,
    startedAt: 0,
  });
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

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        reject(toError(signal.reason));
      },
      { once: true },
    );
  });
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expectConfigurationField(action: () => unknown, field: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).field).toBe(field);
    return;
  }

  throw new Error("Expected ConfigurationError.");
}
