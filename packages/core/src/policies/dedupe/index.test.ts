import { describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { systemClock, type Clock } from "../../core/clock";
import { createBuilder } from "../../core/builder";
import { createContext, releaseContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import { ConfigurationError } from "../../core/errors";
import {
  noopMetrics,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricsRecorder,
} from "../../core/metrics";
import { OPERATION_ARGS_METADATA_KEY } from "../../core/metadata";
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

  it("passes operation arguments from context metadata to the key function", async () => {
    const key = vi.fn(
      (tenantId: unknown, userId: unknown) => `${String(tenantId)}:${String(userId)}`,
    );
    const policy = dedupePolicy.create(createServices(), { key });

    await expect(
      policy.execute(
        createTestContext({
          metadata: {
            [OPERATION_ARGS_METADATA_KEY]: ["tenant", "42"],
          },
        }),
        () => Promise.resolve("ok"),
      ),
    ).resolves.toBe("ok");

    expect(key).toHaveBeenCalledWith("tenant", "42");
    expect(key).toHaveBeenCalledTimes(1);
  });

  it("rejects already-aborted callers without creating shared work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });

    await expect(
      policy.execute(createTestContext({ signal: controller.signal }), next),
    ).rejects.toThrow("cancelled");
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

  it("uses a coordinator-owned shared context for downstream execution", async () => {
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
    expect(observedContext).not.toBe(owner);
    expect(observedContext).not.toBe(joiner);
    expect(observedContext?.requestId).toBe(owner.requestId);
    expect(observedContext?.attemptNumber).toBe(3);
    expect(observedContext?.metadata.get("tenant")).toBe("acme");
    expect(joiner.metadata.get("tenant")).toBe("other");
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("lets owner abort independently while a joiner remains", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const controller = new AbortController();
    const owner = createTestContext({ signal: controller.signal });
    const joiner = createTestContext();
    const gate = createGate<string>();
    let sharedSignal: AbortSignal | undefined;
    const first = policy.execute(owner, (ctx) => {
      sharedSignal = ctx.signal;

      return gate.promise;
    });
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    controller.abort(new Error("owner aborted"));

    await expect(first).rejects.toThrow("owner aborted");
    expect(sharedSignal?.aborted).toBe(false);

    gate.resolve("shared");
    await expect(second).resolves.toBe("shared");
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("lets joiner abort independently while owner remains", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const controller = new AbortController();
    const owner = createTestContext();
    const joiner = createTestContext({ signal: controller.signal });
    const gate = createGate<string>();
    let sharedSignal: AbortSignal | undefined;
    const first = policy.execute(owner, (ctx) => {
      sharedSignal = ctx.signal;

      return gate.promise;
    });
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    controller.abort(new Error("joiner aborted"));

    await expect(second).rejects.toThrow("joiner aborted");
    expect(sharedSignal?.aborted).toBe(false);

    gate.resolve("shared");
    await expect(first).resolves.toBe("shared");
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("aborts shared work when all subscribers abort and abortSharedWhenUnused is true", async () => {
    const policy = dedupePolicy.create(createServices(), { key: () => "user:42" });
    const ownerController = new AbortController();
    const joinerController = new AbortController();
    const owner = createTestContext({ signal: ownerController.signal });
    const joiner = createTestContext({ signal: joinerController.signal });
    let sharedAbortCount = 0;
    const first = policy.execute(owner, (ctx) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          sharedAbortCount += 1;
        },
        { once: true },
      );

      return rejectOnAbort(ctx.signal);
    });
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    ownerController.abort(new Error("owner aborted"));
    joinerController.abort(new Error("joiner aborted"));

    await expect(first).rejects.toThrow("owner aborted");
    await expect(second).rejects.toThrow("joiner aborted");
    await flushMicrotasks();
    expect(sharedAbortCount).toBe(1);
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("keeps shared work alive with zero subscribers when abortSharedWhenUnused is false", async () => {
    const policy = dedupePolicy.create(createServices(), {
      key: () => "user:42",
      abortSharedWhenUnused: false,
    });
    const ownerController = new AbortController();
    const joinerController = new AbortController();
    const owner = createTestContext({ signal: ownerController.signal });
    const joiner = createTestContext({ signal: joinerController.signal });
    const gate = createGate<string>();
    let sharedSignal: AbortSignal | undefined;
    const first = policy.execute(owner, (ctx) => {
      sharedSignal = ctx.signal;

      return gate.promise;
    });
    const second = policy.execute(joiner, () => Promise.resolve("joiner"));

    await flushMicrotasks();
    ownerController.abort(new Error("owner aborted"));
    joinerController.abort(new Error("joiner aborted"));

    await expect(first).rejects.toThrow("owner aborted");
    await expect(second).rejects.toThrow("joiner aborted");
    expect(sharedSignal?.aborted).toBe(false);

    gate.resolve("ignored");
    await flushMicrotasks();
    await expect(policy.execute(createTestContext(), () => Promise.resolve("new"))).resolves.toBe(
      "new",
    );
    releaseContext(owner);
    releaseContext(joiner);
  });

  it("removes caller abort listeners after shared success and failure", async () => {
    const successContext = createTestContext();
    const successRemove = vi.spyOn(successContext.signal, "removeEventListener");
    const successPolicy = dedupePolicy.create(createServices(), { key: () => "success" });

    await expect(successPolicy.execute(successContext, () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
    expect(successRemove).toHaveBeenCalledTimes(1);

    const failureContext = createTestContext();
    const failureRemove = vi.spyOn(failureContext.signal, "removeEventListener");
    const failurePolicy = dedupePolicy.create(createServices(), { key: () => "failure" });

    await expect(
      failurePolicy.execute(failureContext, () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    expect(failureRemove).toHaveBeenCalledTimes(1);
  });

  it("emits miss, join, and completed events in deterministic order without raw keys", async () => {
    const events: ResiliEvent[] = [];
    const clock = new ManualClock();
    const policy = dedupePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        key: () => "secret-user-key",
      },
    );
    const gate = createGate<string>();
    const first = policy.execute(createTestContext(), () => gate.promise);
    const second = policy.execute(createTestContext(), () => Promise.resolve("joiner"));

    await flushMicrotasks();
    gate.resolve("ok");

    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    expect(events.map((event) => event.type)).toEqual([
      "DedupeMiss",
      "DedupeJoined",
      "DedupeCompleted",
    ]);
    expect(events[0]).toMatchObject({
      type: "DedupeMiss",
      role: "owner",
      activeCallers: 1,
      createdAt: 0,
      keyType: "string",
    });
    expect(events[1]).toMatchObject({
      type: "DedupeJoined",
      role: "joiner",
      activeCallers: 2,
      sharedAgeMs: 0,
      keyType: "string",
    });
    expect(events[2]).toMatchObject({
      type: "DedupeCompleted",
      activeCallersAtCompletion: 2,
      totalCallers: 2,
      joinedCallers: 1,
      durationMs: 0,
      sharedAborted: false,
    });
    expect(JSON.stringify(events)).not.toContain("secret-user-key");
  });

  it("emits failed, caller-aborted, and shared-aborted events once", async () => {
    const failedEvents: ResiliEvent[] = [];
    const failedPolicy = dedupePolicy.create(
      createServices({ emit: (event) => failedEvents.push(event) }),
      {
        key: () => "failed",
      },
    );
    const failure = new Error("failed");
    const failedFirst = failedPolicy.execute(createTestContext(), () => Promise.reject(failure));
    const failedSecond = failedPolicy.execute(createTestContext(), () => Promise.resolve("joiner"));

    await expect(failedFirst).rejects.toBe(failure);
    await expect(failedSecond).rejects.toBe(failure);
    expect(failedEvents.map((event) => event.type)).toEqual([
      "DedupeMiss",
      "DedupeJoined",
      "DedupeFailed",
    ]);
    expect(failedEvents.filter((event) => event.type === "DedupeCompleted")).toHaveLength(0);

    const abortEvents: ResiliEvent[] = [];
    const ownerController = new AbortController();
    const joinerController = new AbortController();
    const abortPolicy = dedupePolicy.create(
      createServices({ emit: (event) => abortEvents.push(event) }),
      {
        key: () => "aborted",
      },
    );
    const first = abortPolicy.execute(
      createTestContext({ signal: ownerController.signal }),
      (ctx) => rejectOnAbort(ctx.signal),
    );
    const second = abortPolicy.execute(createTestContext({ signal: joinerController.signal }), () =>
      Promise.resolve("joiner"),
    );

    await flushMicrotasks();
    ownerController.abort(new Error("owner aborted"));
    joinerController.abort(new Error("joiner aborted"));

    await expect(first).rejects.toThrow("owner aborted");
    await expect(second).rejects.toThrow("joiner aborted");
    await flushMicrotasks();
    expect(abortEvents.map((event) => event.type)).toEqual([
      "DedupeMiss",
      "DedupeJoined",
      "DedupeCallerAborted",
      "DedupeCallerAborted",
      "DedupeSharedAborted",
    ]);
    expect(abortEvents.filter((event) => event.type === "DedupeSharedAborted")).toHaveLength(1);
  });

  it("records low-cardinality metrics for success, failure, and caller abort", async () => {
    const clock = new ManualClock();
    const metrics = new RecordingMetrics();
    const successPolicy = dedupePolicy.create(createServices({ clock, metrics }), {
      key: () => "success",
    });
    const gate = createGate<string>();
    const first = successPolicy.execute(createTestContext(), () => gate.promise);
    const second = successPolicy.execute(createTestContext(), () => Promise.resolve("joiner"));

    await flushMicrotasks();
    gate.resolve("ok");
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    await flushMicrotasks();

    expect(metrics.counterValue("resili_dedupe_misses_total", baseLabels())).toBe(1);
    expect(metrics.counterValue("resili_dedupe_joins_total", baseLabels())).toBe(1);
    expect(
      metrics.counterValue("resili_dedupe_callers_total", {
        ...baseLabels(),
        role: "owner",
        result: "success",
      }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_dedupe_callers_total", {
        ...baseLabels(),
        role: "joiner",
        result: "success",
      }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_dedupe_shared_executions_total", {
        ...baseLabels(),
        result: "success",
      }),
    ).toBe(1);
    expect(
      metrics.histogramValues("resili_dedupe_duration_ms", { ...baseLabels(), status: "success" }),
    ).toEqual([0]);
    expect(
      metrics.histogramValues("resili_dedupe_join_wait_ms", { ...baseLabels(), result: "success" }),
    ).toEqual([0]);
    expect(metrics.gaugeValue("resili_dedupe_inflight", baseLabels())).toBe(0);

    const failurePolicy = dedupePolicy.create(createServices({ clock, metrics }), {
      key: () => "failure",
    });
    const failure = new Error("failed");
    const failedOwner = failurePolicy.execute(createTestContext(), () => Promise.reject(failure));
    const failedJoiner = failurePolicy.execute(createTestContext(), () =>
      Promise.resolve("joiner"),
    );

    await expect(failedOwner).rejects.toBe(failure);
    await expect(failedJoiner).rejects.toBe(failure);
    expect(
      metrics.counterValue("resili_dedupe_callers_total", {
        ...baseLabels(),
        role: "joiner",
        result: "error",
      }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_dedupe_shared_executions_total", {
        ...baseLabels(),
        result: "error",
      }),
    ).toBe(1);
    expect(
      metrics.histogramValues("resili_dedupe_join_wait_ms", { ...baseLabels(), result: "error" }),
    ).toEqual([0]);

    const abortPolicy = dedupePolicy.create(createServices({ clock, metrics }), {
      key: () => "abort",
    });
    const controller = new AbortController();
    const aborted = abortPolicy.execute(createTestContext({ signal: controller.signal }), (ctx) =>
      rejectOnAbort(ctx.signal),
    );

    await flushMicrotasks();
    controller.abort(new Error("aborted"));
    await expect(aborted).rejects.toThrow("aborted");
    await flushMicrotasks();
    expect(
      metrics.counterValue("resili_dedupe_callers_total", {
        ...baseLabels(),
        role: "owner",
        result: "aborted",
      }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_dedupe_shared_executions_total", {
        ...baseLabels(),
        result: "aborted_unused",
      }),
    ).toBe(1);
    expect(
      metrics.histogramValues("resili_dedupe_duration_ms", { ...baseLabels(), status: "aborted" }),
    ).toEqual([0]);
    expect(metrics.allLabelNames()).not.toContain("requestId");
    expect(metrics.allLabelNames()).not.toContain("key");
  });

  it("tracks inflight gauge values independently per operation label", async () => {
    const metrics = new RecordingMetrics();
    const keys = ["one", "two"];
    const policy = dedupePolicy.create(createServices({ metrics }), {
      key: () => keys.shift() ?? "fallback",
    });
    const firstGate = createGate<string>();
    const secondGate = createGate<string>();
    const first = policy.execute(
      createTestContext({ operationName: "first" }),
      () => firstGate.promise,
    );
    const second = policy.execute(
      createTestContext({ operationName: "second" }),
      () => secondGate.promise,
    );

    await flushMicrotasks();
    expect(
      metrics.gaugeValue("resili_dedupe_inflight", { service: "service", operation: "first" }),
    ).toBe(1);
    expect(
      metrics.gaugeValue("resili_dedupe_inflight", { service: "service", operation: "second" }),
    ).toBe(1);

    firstGate.resolve("one");
    await expect(first).resolves.toBe("one");
    await flushMicrotasks();
    expect(
      metrics.gaugeValue("resili_dedupe_inflight", { service: "service", operation: "first" }),
    ).toBe(0);
    expect(
      metrics.gaugeValue("resili_dedupe_inflight", { service: "service", operation: "second" }),
    ).toBe(1);

    secondGate.resolve("two");
    await expect(second).resolves.toBe("two");
  });

  it("keeps metrics failures isolated from request behavior", async () => {
    const metrics = new ThrowingMetrics();
    const policy = dedupePolicy.create(createServices({ metrics }), { key: () => "user:42" });

    await expect(policy.execute(createTestContext(), () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
  });

  it("keeps retry attempts deduped only for the current settled attempt", async () => {
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;

      return calls === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve("ok");
    })
      .retry({
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      })
      .dedupe({ key: () => "user:42" })
      .build();

    await expect(Promise.all([client.call(), client.call()])).resolves.toEqual(["ok", "ok"]);
    expect(calls).toBe(2);
  });

  it("keeps timeout local while shared execution continues for another subscriber", async () => {
    const clock = new ManualClock();
    const gate = createGate<string>();
    let sharedSignal: AbortSignal | undefined;
    const client = createBuilder(async () => gate.promise)
      .withClock(clock)
      .timeout(10)
      .dedupe({ key: () => "user:42" })
      .policy({
        name: "capture-shared-signal",
        order: { after: "dedupe" },
        create() {
          return {
            name: "capture-shared-signal",
            order: { after: "dedupe" },
            execute(ctx, next) {
              sharedSignal = ctx.signal;
              return next(ctx);
            },
          };
        },
      })
      .build();
    const first = client.call();
    await flushMicrotasks();
    clock.tick(5);
    const second = client.call();
    await flushMicrotasks();
    clock.tick(5);

    await expect(first).rejects.toThrow("Operation timed out after 10ms.");
    expect(sharedSignal?.aborted).toBe(false);
    gate.resolve("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("creates one hedge coordinator for same-key joiners", async () => {
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;
      return Promise.resolve("ok");
    })
      .dedupe({ key: () => "user:42" })
      .hedge({ delay: 0 })
      .build();

    await expect(Promise.all([client.call(), client.call()])).resolves.toEqual(["ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("does not consume separate rate-limit permits or bulkhead slots for joiners", async () => {
    const gate = createGate<string>();
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;
      return gate.promise;
    })
      .dedupe({ key: () => "user:42" })
      .rateLimiter({ limit: 1, intervalMs: 1_000 })
      .bulkhead({ maxConcurrent: 1 })
      .build();
    const first = client.call();
    const second = client.call();

    await flushMicrotasks();
    expect(calls).toBe(1);
    gate.resolve("ok");
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
  });

  it("reports one circuit-breaker outcome and keeps fallback per caller", async () => {
    let calls = 0;
    const fallback = vi.fn(() => "fallback");
    const client = createBuilder(() => {
      calls += 1;
      return Promise.reject(new Error("failed"));
    })
      .fallback(fallback)
      .circuitBreaker({ minimumThroughput: 2 })
      .dedupe({ key: () => "user:42" })
      .build();

    await expect(Promise.all([client.call(), client.call()])).resolves.toEqual([
      "fallback",
      "fallback",
    ]);
    expect(calls).toBe(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});

function createServices(
  overrides: Partial<Pick<PolicyServices, "clock" | "metrics" | "emit">> = {},
): PolicyServices {
  return Object.freeze({
    clock: overrides.clock ?? systemClock,
    metrics: overrides.metrics ?? noopMetrics,
    emit: overrides.emit ?? noopEmit,
    store: memoryStore(),
    classifier: httpClassifier,
  });
}

function noopEmit(event: ResiliEvent): void {
  void event;
  // Test double.
}

function createTestContext(
  overrides: {
    readonly attemptNumber?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly operationName?: string;
    readonly serviceName?: string;
    readonly signal?: AbortSignal;
  } = {},
): Context {
  return createContext({
    requestId: "request",
    operationName: overrides.operationName ?? "operation",
    serviceName: overrides.serviceName ?? "service",
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

function baseLabels(): Readonly<Record<string, string>> {
  return {
    service: "service",
    operation: "operation",
  };
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

class ManualClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
    const handle = this.#nextHandle++;

    this.#timers.set(handle, {
      at: this.#now + ms,
      callback,
    });

    return handle as ReturnType<typeof globalThis.setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    this.#timers.delete(handle as number);
  }

  tick(ms: number): void {
    this.#now += ms;

    for (const [handle, timer] of [...this.#timers].sort(
      ([leftHandle], [rightHandle]) => leftHandle - rightHandle,
    )) {
      if (timer.at <= this.#now && this.#timers.delete(handle)) {
        timer.callback();
      }
    }
  }
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

  counterValue(name: string, labels: Readonly<Record<string, string>>): number {
    return this.#counters.get(name)?.value(labels) ?? 0;
  }

  gaugeValue(name: string, labels: Readonly<Record<string, string>>): number | undefined {
    return this.#gauges.get(name)?.value(labels);
  }

  histogramValues(name: string, labels: Readonly<Record<string, string>>): readonly number[] {
    return this.#histograms.get(name)?.values(labels) ?? [];
  }

  allLabelNames(): readonly string[] {
    const names = new Set<string>();

    for (const counter of this.#counters.values()) {
      counter.addLabelNames(names);
    }

    for (const gauge of this.#gauges.values()) {
      gauge.addLabelNames(names);
    }

    for (const histogram of this.#histograms.values()) {
      histogram.addLabelNames(names);
    }

    return [...names];
  }
}

class RecordingCounter implements Counter {
  readonly #values = new Map<string, number>();

  add(value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);

    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  value(labels: Readonly<Record<string, string>>): number {
    return this.#values.get(labelKey(labels)) ?? 0;
  }

  addLabelNames(names: Set<string>): void {
    addLabelNames(this.#values, names);
  }
}

class RecordingGauge implements Gauge {
  readonly #values = new Map<string, number>();

  set(value: number, labels?: Readonly<Record<string, string>>): void {
    this.#values.set(labelKey(labels), value);
  }

  value(labels: Readonly<Record<string, string>>): number | undefined {
    return this.#values.get(labelKey(labels));
  }

  addLabelNames(names: Set<string>): void {
    addLabelNames(this.#values, names);
  }
}

class RecordingHistogram implements Histogram {
  readonly #values = new Map<string, number[]>();

  record(value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);
    const values = this.#values.get(key);

    if (values === undefined) {
      this.#values.set(key, [value]);
      return;
    }

    values.push(value);
  }

  values(labels: Readonly<Record<string, string>>): readonly number[] {
    return this.#values.get(labelKey(labels)) ?? [];
  }

  addLabelNames(names: Set<string>): void {
    addLabelNames(this.#values, names);
  }
}

class ThrowingMetrics implements MetricsRecorder {
  counter(): Counter {
    throw new Error("counter failed");
  }

  gauge(): Gauge {
    throw new Error("gauge failed");
  }

  histogram(): Histogram {
    throw new Error("histogram failed");
  }
}

function labelKey(labels: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(labels ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000");
}

function addLabelNames(values: ReadonlyMap<string, unknown>, names: Set<string>): void {
  for (const key of values.keys()) {
    for (const label of key.split("\u0000")) {
      if (label.length === 0) {
        continue;
      }

      names.add(label.slice(0, label.indexOf("=")));
    }
  }
}
