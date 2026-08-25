import { describe, expect, it, vi } from "vitest";

import { createBuilder } from "../builder";
import type { Clock } from "../clock";
import type { ResiliEvent } from "../events";
import { TimeoutError } from "../errors";
import { definePolicy } from "../policy";
import { compilePipeline } from "../pipeline";
import { createCoreClient } from "./index";

describe("core client hardening", () => {
  it("emits one lifecycle pair around the pipeline, including retries", async () => {
    let calls = 0;
    const started: ResiliEvent[] = [];
    const completed: ResiliEvent[] = [];
    const retries: ResiliEvent[] = [];
    const client = createBuilder(() => {
      calls += 1;

      return calls === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("ok");
    })
      .retry({
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      })
      .on("RequestStarted", (event) => {
        started.push(event);
      })
      .on("RequestCompleted", (event) => {
        completed.push(event);
      })
      .on("RetryStarted", (event) => {
        retries.push(event);
      })
      .build();

    await expect(client.call()).resolves.toBe("ok");

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(retries).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "RequestCompleted",
      status: "success",
      attempts: 2,
    });
    expect(started[0]?.type).toBe("RequestStarted");
    expect(client.stats().totals).toEqual({
      calls: 1,
      successes: 1,
      failures: 0,
      retries: 1,
    });
  });

  it("emits RequestCompleted with status error when the top-level call fails", async () => {
    const completed = vi.fn();
    const client = createBuilder(() => Promise.reject(new Error("boom")))
      .on("RequestCompleted", completed)
      .build();

    await expect(client.call()).rejects.toThrow("boom");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      attempts: 1,
    });
    expect("errorCode" in (completed.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it("treats successful fallback as a successful completion", async () => {
    const completed = vi.fn();
    const client = createBuilder(() => Promise.reject(new Error("downstream")))
      .fallback({
        handler() {
          return "fallback";
        },
      })
      .on("RequestCompleted", completed)
      .build();

    await expect(client.call()).resolves.toBe("fallback");
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        attempts: 1,
      }),
    );
    expect(client.stats().totals.successes).toBe(1);
    expect(client.stats().totals.failures).toBe(0);
  });

  it("still completes after timeout and abort", async () => {
    const clock = createManualClock();
    const timeoutCompleted = vi.fn();
    const timeoutClient = createBuilder(
      () =>
        new Promise<string>(() => {
          // Never settles.
        }),
    )
      .withClock(clock)
      .timeout(10)
      .on("RequestCompleted", timeoutCompleted)
      .build();

    const timeoutResult = timeoutClient.call();
    await Promise.resolve();
    await Promise.resolve();
    clock.tick(10);
    await expect(timeoutResult).rejects.toBeInstanceOf(TimeoutError);
    expect(timeoutCompleted.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      errorCode: "ERR_TIMEOUT",
    });

    const abortCompleted = vi.fn();
    const controller = new AbortController();
    const abortClient = createBuilder(() => Promise.resolve("unused"))
      .on("RequestCompleted", abortCompleted)
      .build();
    const aborted = abortClient.execute(
      (ctx) =>
        new Promise<string>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = ctx.signal.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(Error);
    expect(abortCompleted).toHaveBeenCalledTimes(1);
    expect(abortCompleted.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
    });
  });

  it("keeps RequestStarted ahead of policy events and RequestCompleted last", async () => {
    const order: string[] = [];
    const client = createBuilder(() => Promise.resolve("ok"))
      .on("RequestStarted", () => {
        order.push("started");
      })
      .on("RequestCompleted", () => {
        order.push("completed");
      })
      .policy(
        definePolicy({
          name: "observer",
          order: 100,
          create() {
            return {
              name: "observer",
              order: 100,
              async execute(_ctx, next) {
                order.push("policy");

                return next(_ctx);
              },
            };
          },
        }),
      )
      .build();

    await client.call();
    expect(order).toEqual(["started", "policy", "completed"]);
  });

  it("does not increment retries on first-attempt success", async () => {
    const client = createBuilder(() => Promise.resolve("ok"))
      .retry({ maxAttempts: 3, jitter: "none" })
      .build();

    await client.call();
    expect(client.stats().totals.retries).toBe(0);
  });

  it("counts multiple retries and isolates clients", async () => {
    let calls = 0;
    const retrying = createBuilder(() => {
      calls += 1;

      return calls < 3 ? Promise.reject(new Error("transient")) : Promise.resolve("ok");
    })
      .retry({
        maxAttempts: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      })
      .build();
    const other = createBuilder(() => Promise.resolve("ok")).build();

    await retrying.call();
    await other.call();

    expect(retrying.stats().totals).toEqual({
      calls: 1,
      successes: 1,
      failures: 0,
      retries: 2,
    });
    expect(other.stats().totals).toEqual({
      calls: 1,
      successes: 1,
      failures: 0,
      retries: 0,
    });
  });

  it("lets an outer timeout abort rate-limiter wait", async () => {
    const clock = createManualClock();
    const client = createBuilder(() => Promise.resolve("ok"))
      .withClock(clock)
      .timeout(10)
      .rateLimiter({ limit: 1, intervalMs: 100, onLimit: "wait", maxWaitMs: 100 })
      .build();

    await client.call();
    const waiting = client.call();
    await Promise.resolve();
    await Promise.resolve();
    clock.tick(10);
    await expect(waiting).rejects.toBeInstanceOf(TimeoutError);
  });

  it("starts with empty policy maps and healthy status", () => {
    const client = createCoreClient({
      operation: () => Promise.resolve("ok"),
      pipeline: compilePipeline([]),
    });

    expect(client.stats()).toEqual({
      circuit: {},
      bulkhead: {},
      rateLimiter: {},
      totals: { calls: 0, successes: 0, failures: 0, retries: 0 },
    });
    expect(client.health()).toEqual({
      status: "healthy",
      openCircuits: [],
      details: client.stats(),
    });
  });

  it("accumulates totals across requests without fabricating policy state", async () => {
    const client = createBuilder((shouldFail: boolean) =>
      shouldFail ? Promise.reject(new Error("nope")) : Promise.resolve("ok"),
    ).build();

    await client.call(false);
    await expect(client.call(true)).rejects.toThrow("nope");

    expect(client.stats().circuit).toEqual({});
    expect(client.stats().bulkhead).toEqual({});
    expect(client.stats().rateLimiter).toEqual({});
    expect(client.stats().totals).toEqual({
      calls: 2,
      successes: 1,
      failures: 1,
      retries: 0,
    });
    expect(client.health().status).toBe("healthy");
  });
});

interface ManualClock extends Clock {
  tick(ms: number): void;
}

function createManualClock(): ManualClock {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  return {
    now(): number {
      return now;
    },
    setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });

      return handle;
    },
    clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
      timers.delete(handle as number);
    },
    tick(ms: number): void {
      now += ms;

      for (const [handle, timer] of [...timers].sort(
        ([leftHandle], [rightHandle]) => leftHandle - rightHandle,
      )) {
        if (timer.at <= now && timers.delete(handle)) {
          timer.callback();
        }
      }
    },
  };
}
