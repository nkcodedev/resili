import { afterEach, describe, expect, it, vi } from "vitest";

import { httpClassifier } from "../../core/classification";
import { createBuilder } from "../../core/builder";
import type { Clock } from "../../core/clock";
import { createContext, releaseContext, type Context } from "../../core/context";
import type { ResiliEvent } from "../../core/events";
import {
  AbortError,
  ConfigurationError,
  RetryExceededError,
  TimeoutError,
} from "../../core/errors";
import {
  noopMetrics,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricsRecorder,
} from "../../core/metrics";
import type { Next, PolicyServices } from "../../core/policy";
import { memoryStore } from "../../core/state";
import { hedgePolicy } from "./index";

afterEach(() => {
  vi.useRealTimers();
});

describe("hedgePolicy", () => {
  it("creates an immutable policy from valid options", () => {
    const policy = hedgePolicy.create(createServices(), { delay: 50 });

    expect(hedgePolicy.name).toBe("hedge");
    expect(hedgePolicy.order).toBe(450);
    expect(policy.name).toBe("hedge");
    expect(policy.order).toBe(450);
    expect(Object.isFrozen(hedgePolicy)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("starts the original attempt before scheduling the hedge", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 50 });
    const calls: number[] = [];
    const first = createGate<string>();
    const result = policy.execute(createTestContext(), (ctx) => {
      calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

      return first.promise;
    });

    await flushMicrotasks();

    expect(calls).toEqual([1]);
    expect(clock.activeTimers).toBe(1);

    first.resolve("ok");
    await expect(result).resolves.toBe("ok");
    expect(clock.activeTimers).toBe(0);
  });

  it("does not start the hedge when original succeeds before delay", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 50 });
    const calls: number[] = [];

    await expect(
      policy.execute(createTestContext(), (ctx) => {
        calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

        return Promise.resolve("original");
      }),
    ).resolves.toBe("original");

    clock.tick(50);
    await flushMicrotasks();

    expect(calls).toEqual([1]);
    expect(clock.activeTimers).toBe(0);
    expect(clock.clearedTimers).toBe(1);
  });

  it("starts the hedge when delay elapses", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 50 });
    const calls: number[] = [];
    const first = createGate<string>();
    const second = createGate<string>();
    const result = policy.execute(createTestContext(), (ctx) => {
      calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

      return calls.length === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    clock.tick(49);
    await flushMicrotasks();
    expect(calls).toEqual([1]);

    clock.tick(1);
    await flushMicrotasks();
    expect(calls).toEqual([1, 2]);

    second.resolve("hedge");
    await expect(result).resolves.toBe("hedge");
    first.resolve("late");
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
  });

  it("starts a delay 0 hedge in deterministic order after the original", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 0 });
    const calls: number[] = [];
    const gates = [createGate<string>(), createGate<string>()];
    const result = policy.execute(createTestContext(), (ctx) => {
      calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

      return gates[calls.length - 1]?.promise ?? Promise.reject(new Error("too many calls"));
    });

    clock.tick(0);
    await flushMicrotasks();

    expect(calls).toEqual([1, 2]);

    gates[0]?.resolve("original");
    await expect(result).resolves.toBe("original");
    gates[1]?.resolve("late");
  });

  it("lets the original win after the hedge has started", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();

    first.resolve("original");
    await expect(result).resolves.toBe("original");

    second.resolve("late");
    await flushMicrotasks();
    expect(calls).toBe(2);
  });

  it("settles exactly once and ignores late loser settlement", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    let settled = 0;
    const result = policy
      .execute(createTestContext(), () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      })
      .finally(() => {
        settled += 1;
      });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();

    second.resolve("hedge");
    await expect(result).resolves.toBe("hedge");

    first.reject(new Error("late loser"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(settled).toBe(1);
  });

  it("waits for the hedge when original fails before delay", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const calls: number[] = [];
    const result = policy.execute(createTestContext(), (ctx) => {
      calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

      return calls.length === 1 ? Promise.reject(new Error("original")) : Promise.resolve("hedge");
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls).toEqual([1]);

    clock.tick(10);
    await expect(result).resolves.toBe("hedge");
  });

  it("waits for original when hedge fails first", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const first = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : Promise.reject(new Error("hedge"));
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();
    await flushMicrotasks();

    first.resolve("original");
    await expect(result).resolves.toBe("original");
  });

  it("rejects with the deterministic last failure when both attempts fail", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const originalFailure = new Error("original");
    const hedgeFailure = new Error("hedge");
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();

    first.reject(originalFailure);
    await flushMicrotasks();
    second.reject(hedgeFailure);

    await expect(result).rejects.toBe(hedgeFailure);
  });

  it("uses shouldAccept for winner selection", async () => {
    const clock = new FakeClock();
    const shouldAccept = vi.fn((value: string) => value === "hedge");
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10, shouldAccept });
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    first.resolve("original");
    await flushMicrotasks();

    clock.tick(10);
    await flushMicrotasks();
    second.resolve("hedge");

    await expect(result).resolves.toBe("hedge");
    expect(shouldAccept).toHaveBeenCalledTimes(2);
  });

  it("rejects when both fulfilled values are unacceptable", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), {
      delay: 10,
      shouldAccept: () => false,
    });
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    first.resolve("original");
    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();
    second.resolve("hedge");

    await expect(result).rejects.toThrow("No acceptable hedged result completed.");
  });

  it("treats shouldAccept throws as attempt failures", async () => {
    const clock = new FakeClock();
    const acceptFailure = new Error("accept failed");
    const policy = hedgePolicy.create(createServices({ clock }), {
      delay: 10,
      shouldAccept() {
        throw acceptFailure;
      },
    });
    const result = policy.execute(createTestContext(), () => Promise.resolve("value"));

    clock.tick(10);

    await expect(result).rejects.toBe(acceptFailure);
  });

  it("preserves the final thrown error when paired with an unacceptable value", async () => {
    const clock = new FakeClock();
    const hedgeFailure = new Error("hedge");
    const policy = hedgePolicy.create(createServices({ clock }), {
      delay: 10,
      shouldAccept: (value: string) => value !== "original",
    });
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? Promise.resolve("original") : Promise.reject(hedgeFailure);
    });

    await flushMicrotasks();
    clock.tick(10);

    await expect(result).rejects.toBe(hedgeFailure);
  });

  it("aborts active losing attempts when abortLosers is true", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const observedSignals: AbortSignal[] = [];
    const first = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), (ctx) => {
      calls += 1;
      observedSignals.push(ctx.signal);

      return calls === 1 ? first.promise : Promise.resolve("hedge");
    });

    await flushMicrotasks();
    clock.tick(10);
    await expect(result).resolves.toBe("hedge");

    expect(observedSignals[0]?.aborted).toBe(true);
    first.resolve("late");
  });

  it("does not abort active losing attempts when abortLosers is false", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10, abortLosers: false });
    const observedSignals: AbortSignal[] = [];
    const first = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), (ctx) => {
      calls += 1;
      observedSignals.push(ctx.signal);

      return calls === 1 ? first.promise : Promise.resolve("hedge");
    });

    await flushMicrotasks();
    clock.tick(10);
    await expect(result).resolves.toBe("hedge");

    expect(observedSignals[0]?.aborted).toBe(false);
    first.resolve("late");
  });

  it("handles parent already aborted before execution", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const policy = hedgePolicy.create(createServices(), { delay: 10 });
    const next = vi.fn<Next<string>>(() => Promise.resolve("ok"));

    await expect(
      policy.execute(createTestContext({ signal: controller.signal }), next),
    ).rejects.toBe(reason);
    expect(next).not.toHaveBeenCalled();
  });

  it("handles parent abort before hedge delay and prevents hedge start", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const calls: number[] = [];
    const result = policy.execute(createTestContext({ signal: controller.signal }), (ctx) => {
      calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

      return rejectOnAbort(ctx.signal);
    });

    await flushMicrotasks();
    controller.abort("cancelled");

    await expect(result).rejects.toBeInstanceOf(AbortError);
    clock.tick(10);
    await flushMicrotasks();

    expect(calls).toEqual([1]);
    expect(clock.activeTimers).toBe(0);
  });

  it("handles parent abort after hedge starts and aborts both attempt signals", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10 });
    const observedSignals: AbortSignal[] = [];
    const result = policy.execute(createTestContext({ signal: controller.signal }), (ctx) => {
      observedSignals.push(ctx.signal);

      return rejectOnAbort(ctx.signal);
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();
    controller.abort(new Error("cancelled"));

    await expect(result).rejects.toThrow("cancelled");
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("preserves hedge metadata, retry attempt number, and parent metadata", async () => {
    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10, abortLosers: false });
    const parent = createTestContext({ attemptNumber: 4, metadata: { tenant: "acme" } });
    const seen: Context[] = [];
    const first = createGate<string>();
    const second = createGate<string>();
    const result = policy.execute(parent, (ctx) => {
      seen.push(ctx);

      return seen.length === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();

    second.resolve("hedge");
    await expect(result).resolves.toBe("hedge");
    first.resolve("late");

    expect(seen.map((ctx) => ctx.attemptNumber)).toEqual([4, 4]);
    expect(seen.map((ctx) => ctx.metadata.get("resili.hedgeAttempt"))).toEqual([1, 2]);
    expect(seen.map((ctx) => ctx.metadata.get("tenant"))).toEqual(["acme", "acme"]);
    expect(parent.metadata.get("resili.hedgeAttempt")).toBeUndefined();

    releaseContext(parent);
  });

  it("releases child context deadline timers without releasing the parent context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 10, abortLosers: false });
    const parent = createTestContext({ deadline: 1_000 });
    const first = createGate<string>();
    const second = createGate<string>();
    let calls = 0;
    const result = policy.execute(parent, () => {
      calls += 1;

      return calls === 1 ? first.promise : second.promise;
    });

    await flushMicrotasks();
    clock.tick(10);
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(3);

    second.resolve("hedge");
    await expect(result).resolves.toBe("hedge");
    first.resolve("late");
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(1);

    releaseContext(parent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the hedge when delay is beyond the current deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const clock = new FakeClock();
    const policy = hedgePolicy.create(createServices({ clock }), { delay: 100 });
    const parent = createTestContext({ deadline: 50 });
    const calls: number[] = [];

    await expect(
      policy.execute(parent, (ctx) => {
        calls.push(Number(ctx.metadata.get("resili.hedgeAttempt")));

        return Promise.resolve("original");
      }),
    ).resolves.toBe("original");

    clock.tick(100);
    await flushMicrotasks();

    expect(calls).toEqual([1]);
    releaseContext(parent);
  });

  it("emits scheduled then completed when original wins before delay", async () => {
    const clock = new FakeClock();
    const events: ResiliEvent[] = [];
    const policy = hedgePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        delay: 50,
      },
    );

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("original")),
    ).resolves.toBe("original");

    expect(events.map((event) => event.type)).toEqual(["HedgeScheduled", "HedgeCompleted"]);
    expect(events[0]).toMatchObject({
      type: "HedgeScheduled",
      timestamp: 0,
      attemptNumber: 1,
      hedgeAttempt: 2,
      delayMs: 50,
      scheduledAt: 0,
    });
    expect(events[1]).toMatchObject({
      type: "HedgeCompleted",
      winningHedgeAttempt: 1,
      hedged: false,
      startedAttempts: 1,
      durationMs: 0,
      losersAborted: false,
    });
  });

  it("emits scheduled, started, and completed when hedge wins", async () => {
    const clock = new FakeClock();
    const events: ResiliEvent[] = [];
    const policy = hedgePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        delay: 10,
      },
    );
    const first = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : Promise.resolve("hedge");
    });

    await flushMicrotasks();
    clock.tick(10);

    await expect(result).resolves.toBe("hedge");

    expect(events.map((event) => event.type)).toEqual([
      "HedgeScheduled",
      "HedgeStarted",
      "HedgeCompleted",
    ]);
    expect(events[1]).toMatchObject({
      type: "HedgeStarted",
      timestamp: 10,
      hedgeAttempt: 2,
      delayMs: 10,
      startedAt: 10,
    });
    expect(events[2]).toMatchObject({
      type: "HedgeCompleted",
      winningHedgeAttempt: 2,
      hedged: true,
      startedAttempts: 2,
      durationMs: 10,
      losersAborted: true,
    });

    first.resolve("late");
  });

  it("emits skipped then completed when deadline prevents hedge scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const clock = new FakeClock();
    const events: ResiliEvent[] = [];
    const policy = hedgePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        delay: 100,
      },
    );
    const parent = createTestContext({ deadline: 50 });

    await expect(policy.execute(parent, () => Promise.resolve("original"))).resolves.toBe(
      "original",
    );

    expect(events.map((event) => event.type)).toEqual(["HedgeSkipped", "HedgeCompleted"]);
    expect(events[0]).toMatchObject({
      type: "HedgeSkipped",
      reason: "deadline",
      delayMs: 100,
      remainingMs: 50,
    });
    releaseContext(parent);
  });

  it("emits scheduled, started, and failed with last Resili error code", async () => {
    const clock = new FakeClock();
    const events: ResiliEvent[] = [];
    const policy = hedgePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        delay: 10,
      },
    );
    const result = policy.execute(createTestContext(), (ctx) =>
      Number(ctx.metadata.get("resili.hedgeAttempt")) === 1
        ? Promise.reject(new Error("original"))
        : Promise.reject(new TimeoutError({ timeoutMs: 1 })),
    );

    await flushMicrotasks();
    clock.tick(10);

    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(events.map((event) => event.type)).toEqual([
      "HedgeScheduled",
      "HedgeStarted",
      "HedgeFailed",
    ]);
    expect(events[2]).toMatchObject({
      type: "HedgeFailed",
      startedAttempts: 2,
      hedged: true,
      durationMs: 10,
      lastErrorCode: "ERR_TIMEOUT",
    });
  });

  it("emits scheduled then aborted for parent abort before delay", async () => {
    const clock = new FakeClock();
    const events: ResiliEvent[] = [];
    const controller = new AbortController();
    const policy = hedgePolicy.create(
      createServices({ clock, emit: (event) => events.push(event) }),
      {
        delay: 10,
      },
    );
    const result = policy.execute(createTestContext({ signal: controller.signal }), (ctx) =>
      rejectOnAbort(ctx.signal),
    );

    await flushMicrotasks();
    clock.tick(5);
    controller.abort(new AbortError());

    await expect(result).rejects.toBeInstanceOf(AbortError);
    expect(events.map((event) => event.type)).toEqual(["HedgeScheduled", "HedgeAborted"]);
    expect(events[1]).toMatchObject({
      type: "HedgeAborted",
      startedAttempts: 1,
      hedgeStarted: false,
      durationMs: 5,
      reasonCode: "ERR_ABORTED",
    });
  });

  it("emits aborted without scheduled when parent is already aborted", async () => {
    const events: ResiliEvent[] = [];
    const controller = new AbortController();
    controller.abort(new AbortError());
    const policy = hedgePolicy.create(createServices({ emit: (event) => events.push(event) }), {
      delay: 10,
    });

    await expect(
      policy.execute(createTestContext({ signal: controller.signal }), () => Promise.resolve("ok")),
    ).rejects.toBeInstanceOf(AbortError);

    expect(events.map((event) => event.type)).toEqual(["HedgeAborted"]);
    expect(events[0]).toMatchObject({
      type: "HedgeAborted",
      startedAttempts: 0,
      hedgeStarted: false,
    });
  });

  it("records success metrics when original wins before hedge starts", async () => {
    const clock = new FakeClock();
    const metrics = new RecordingMetrics();
    const policy = hedgePolicy.create(createServices({ clock, metrics }), { delay: 50 });

    await expect(
      policy.execute(createTestContext(), () => Promise.resolve("original")),
    ).resolves.toBe("original");

    expect(metrics.counterValue("resili_hedges_started_total", baseLabels())).toBe(0);
    expect(
      metrics.counterValue("resili_hedges_won_total", { ...baseLabels(), winner: "original" }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "success" }),
    ).toBe(1);
    expect(
      metrics.histogramValues("resili_hedge_duration_ms", { ...baseLabels(), status: "success" }),
    ).toEqual([0]);
    expect(metrics.histogramValues("resili_hedge_delay_ms", baseLabels())).toEqual([50]);
    expect(metrics.allLabels()).not.toContain("requestId");
  });

  it("records hedge winner and aborted loser metrics", async () => {
    const clock = new FakeClock();
    const metrics = new RecordingMetrics();
    const policy = hedgePolicy.create(createServices({ clock, metrics }), { delay: 10 });
    const first = createGate<string>();
    let calls = 0;
    const result = policy.execute(createTestContext(), () => {
      calls += 1;

      return calls === 1 ? first.promise : Promise.resolve("hedge");
    });

    await flushMicrotasks();
    clock.tick(10);

    await expect(result).resolves.toBe("hedge");

    expect(metrics.counterValue("resili_hedges_started_total", baseLabels())).toBe(1);
    expect(
      metrics.counterValue("resili_hedges_won_total", { ...baseLabels(), winner: "hedge" }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "success" }),
    ).toBe(1);
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "aborted" }),
    ).toBe(1);
    expect(
      metrics.histogramValues("resili_hedge_duration_ms", { ...baseLabels(), status: "success" }),
    ).toEqual([10]);

    first.reject(new Error("late"));
    await flushMicrotasks();
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "error" }),
    ).toBe(0);
  });

  it("records failed, unacceptable, and aborted metrics without duplicate counting", async () => {
    const clock = new FakeClock();
    const metrics = new RecordingMetrics();
    const failed = hedgePolicy.create(createServices({ clock, metrics }), { delay: 0 });

    const failedResult = failed.execute(createTestContext(), () =>
      Promise.reject(new Error("failed")),
    );

    clock.tick(0);
    await expect(failedResult).rejects.toThrow("failed");

    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "error" }),
    ).toBe(2);
    expect(
      metrics.histogramValues("resili_hedge_duration_ms", { ...baseLabels(), status: "failed" }),
    ).toEqual([0]);

    const unacceptable = hedgePolicy.create(createServices({ clock, metrics }), {
      delay: 0,
      shouldAccept: () => false,
    });
    const unacceptableResult = unacceptable.execute(createTestContext(), () =>
      Promise.resolve("no"),
    );

    clock.tick(0);
    await expect(unacceptableResult).rejects.toThrow("No acceptable hedged result completed.");

    expect(
      metrics.counterValue("resili_hedge_attempts_total", {
        ...baseLabels(),
        result: "unacceptable",
      }),
    ).toBe(2);

    const controller = new AbortController();
    const aborted = hedgePolicy.create(createServices({ clock, metrics }), { delay: 0 });
    const abortedResult = aborted.execute(createTestContext({ signal: controller.signal }), (ctx) =>
      rejectOnAbort(ctx.signal),
    );

    clock.tick(0);
    await flushMicrotasks();
    controller.abort("cancelled");

    await expect(abortedResult).rejects.toBeInstanceOf(AbortError);
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "aborted" }),
    ).toBe(2);
    expect(
      metrics.histogramValues("resili_hedge_duration_ms", { ...baseLabels(), status: "aborted" }),
    ).toEqual([0]);
  });

  it("does not record scheduled or hedge-started metrics when deadline skips scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const clock = new FakeClock();
    const metrics = new RecordingMetrics();
    const policy = hedgePolicy.create(createServices({ clock, metrics }), { delay: 100 });
    const parent = createTestContext({ deadline: 50 });

    await expect(policy.execute(parent, () => Promise.resolve("original"))).resolves.toBe(
      "original",
    );

    expect(metrics.counterValue("resili_hedges_started_total", baseLabels())).toBe(0);
    expect(metrics.histogramValues("resili_hedge_delay_ms", baseLabels())).toEqual([]);
    expect(
      metrics.counterValue("resili_hedge_attempts_total", { ...baseLabels(), result: "success" }),
    ).toBe(1);
    releaseContext(parent);
  });

  it("rejects missing and invalid delay options with field paths", () => {
    const services = createServices();

    expectConfigurationField(() => hedgePolicy.create(services), "hedge");
    expectConfigurationField(() => hedgePolicy.create(services, {}), "hedge.delay");
    expectConfigurationField(() => hedgePolicy.create(services, { delay: -1 }), "hedge.delay");
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: Number.NaN }),
      "hedge.delay",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: Number.POSITIVE_INFINITY }),
      "hedge.delay",
    );
    expectConfigurationField(() => hedgePolicy.create(services, { delay: "100" }), "hedge.delay");
  });

  it("rejects invalid optional values with field paths", () => {
    const services = createServices();

    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, maxAttempts: 1 }),
      "hedge.maxAttempts",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, maxAttempts: 3 }),
      "hedge.maxAttempts",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, shouldAccept: true }),
      "hedge.shouldAccept",
    );
    expectConfigurationField(
      () => hedgePolicy.create(services, { delay: 10, abortLosers: "yes" }),
      "hedge.abortLosers",
    );
  });

  it("allows retry wrapping hedge to execute up to retry attempts times two", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;

      return Promise.reject(new Error(`failed:${String(calls)}`));
    })
      .withClock(clock)
      .retry({
        maxAttempts: 2,
        backoff: "fixed",
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      })
      .hedge({ delay: 0 })
      .build();
    const result = client.call();

    clock.tick(0);
    await flushMicrotasks();
    await flushMicrotasks();
    clock.tick(0);

    await expect(result).rejects.toBeInstanceOf(RetryExceededError);
    expect(calls).toBe(4);
  });

  it("allows fallback to handle terminal hedge failure", async () => {
    const clock = new FakeClock();
    const client = createBuilder(() => Promise.reject(new Error("failed")))
      .withClock(clock)
      .hedge({ delay: 0 })
      .fallback(() => "fallback")
      .build();
    const result = client.call();

    clock.tick(0);

    await expect(result).resolves.toBe("fallback");
  });

  it("keeps timeout wrapped around both hedge attempts", async () => {
    const clock = new FakeClock();
    const observedSignals: AbortSignal[] = [];
    const client = createBuilder(() => Promise.resolve("unused"))
      .withClock(clock)
      .timeout(10)
      .hedge({ delay: 0 })
      .build();
    const result = client.execute((ctx) => {
      observedSignals.push(ctx.signal);

      return rejectOnAbort(ctx.signal);
    });

    clock.tick(0);
    await flushMicrotasks();
    clock.tick(10);

    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps rate limiter downstream of hedge", async () => {
    const clock = new FakeClock();
    const first = createGate<string>();
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;

      return first.promise;
    })
      .withClock(clock)
      .hedge({ delay: 0 })
      .rateLimiter({ limit: 1, intervalMs: 100 })
      .build();
    const result = client.call();

    await flushMicrotasks();
    clock.tick(0);
    await flushMicrotasks();

    first.resolve("original");
    await expect(result).resolves.toBe("original");
    expect(calls).toBe(1);
  });

  it("keeps bulkhead downstream of hedge", async () => {
    const clock = new FakeClock();
    const first = createGate<string>();
    let calls = 0;
    const client = createBuilder(() => {
      calls += 1;

      return first.promise;
    })
      .withClock(clock)
      .hedge({ delay: 0 })
      .bulkhead({ maxConcurrent: 1 })
      .build();
    const result = client.call();

    await flushMicrotasks();
    clock.tick(0);
    await flushMicrotasks();

    first.resolve("original");
    await expect(result).resolves.toBe("original");
    expect(calls).toBe(1);
  });
});

function createServices(
  overrides: Partial<Pick<PolicyServices, "clock" | "emit" | "metrics">> = {},
): PolicyServices {
  return Object.freeze({
    clock: overrides.clock ?? new FakeClock(),
    metrics: overrides.metrics ?? noopMetrics,
    emit:
      overrides.emit ??
      ((event: ResiliEvent): void => {
        void event;
        // Test double.
      }),
    store: memoryStore(),
    classifier: httpClassifier,
  });
}

function baseLabels(): Readonly<Record<string, string>> {
  return { service: "service", operation: "operation" };
}

function createTestContext(
  overrides: {
    readonly attemptNumber?: number;
    readonly deadline?: number;
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
    deadline: overrides.deadline,
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

class RecordingMetrics implements MetricsRecorder {
  readonly #counters = new Map<string, RecordingCounter>();
  readonly #histograms = new Map<string, RecordingHistogram>();

  counter(name: string): Counter {
    let counter = this.#counters.get(name);

    if (counter === undefined) {
      counter = new RecordingCounter();
      this.#counters.set(name, counter);
    }

    return counter;
  }

  gauge(): Gauge {
    return noopMetrics.gauge("unused");
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

  histogramValues(name: string, labels: Readonly<Record<string, string>>): readonly number[] {
    return this.#histograms.get(name)?.values(labels) ?? [];
  }

  allLabels(): readonly string[] {
    const labels = new Set<string>();

    for (const counter of this.#counters.values()) {
      for (const key of counter.labelKeys()) {
        labels.add(key);
      }
    }

    for (const histogram of this.#histograms.values()) {
      for (const key of histogram.labelKeys()) {
        labels.add(key);
      }
    }

    return [...labels].sort();
  }
}

class RecordingCounter implements Counter {
  readonly #values = new Map<string, number>();
  readonly #labelKeys = new Set<string>();

  add(value: number, labels?: Readonly<Record<string, string>>): void {
    for (const key of Object.keys(labels ?? {})) {
      this.#labelKeys.add(key);
    }

    const key = labelKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  value(labels: Readonly<Record<string, string>>): number {
    return this.#values.get(labelKey(labels)) ?? 0;
  }

  labelKeys(): readonly string[] {
    return [...this.#labelKeys];
  }
}

class RecordingHistogram implements Histogram {
  readonly #values = new Map<string, number[]>();
  readonly #labelKeys = new Set<string>();

  record(value: number, labels?: Readonly<Record<string, string>>): void {
    for (const key of Object.keys(labels ?? {})) {
      this.#labelKeys.add(key);
    }

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

  labelKeys(): readonly string[] {
    return [...this.#labelKeys];
  }
}

function labelKey(labels: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(labels ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0000");
}

class FakeClock implements Clock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  clearedTimers = 0;

  get activeTimers(): number {
    return this.#timers.size;
  }

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
    if (this.#timers.delete(handle as number)) {
      this.clearedTimers += 1;
    }
  }

  tick(ms: number): void {
    const target = this.#now + ms;
    let next = this.#nextDueTimer(target);

    while (next !== undefined) {
      this.#timers.delete(next.handle);
      this.#now = next.at;
      next.callback();
      next = this.#nextDueTimer(target);
    }

    this.#now = target;
  }

  #nextDueTimer(
    target: number,
  ): { readonly handle: number; readonly at: number; readonly callback: () => void } | undefined {
    let next:
      { readonly handle: number; readonly at: number; readonly callback: () => void } | undefined;

    for (const [handle, timer] of this.#timers) {
      if (timer.at > target) {
        continue;
      }

      if (
        next === undefined ||
        timer.at < next.at ||
        (timer.at === next.at && handle < next.handle)
      ) {
        next = { handle, at: timer.at, callback: timer.callback };
      }
    }

    return next;
  }
}
