import { describe, expect, it } from "vitest";

import { createClient, TimeoutError } from "../../index";

describe("core policy interaction regressions", () => {
  it("keeps canonical policy order around the operation", async () => {
    const events: string[] = [];
    const client = createClient(
      () => {
        events.push("operation");

        return Promise.resolve("ok");
      },
      {
        fallback: {
          handler() {
            return "fallback";
          },
        },
        cache: { key: () => "k", ttl: 1_000 },
        retry: { maxAttempts: 1, jitter: "none" },
        circuitBreaker: { minimumThroughput: 1 },
        timeout: { perAttemptMs: 1_000 },
        dedupe: { key: () => "k" },
        hedge: { delay: 10_000 },
        rateLimiter: { limit: 10, intervalMs: 1_000, onLimit: "reject" },
        bulkhead: { maxConcurrent: 4 },
      },
    );

    await expect(client.call()).resolves.toBe("ok");
    expect(events).toEqual(["operation"]);
  });

  it("retries a timed-out attempt then succeeds", async () => {
    let attempts = 0;
    const client = createClient(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise(() => undefined);
        }

        return "ok";
      },
      {
        timeout: { perAttemptMs: 20 },
        retry: {
          maxAttempts: 2,
          jitter: "none",
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
    );

    await expect(client.call()).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries under a closed circuit breaker", async () => {
    let attempts = 0;
    const client = createClient(
      () => {
        attempts += 1;
        return Promise.reject(new Error("down"));
      },
      {
        retry: {
          maxAttempts: 2,
          jitter: "none",
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryOn(outcome) {
            return outcome.status === "error";
          },
        },
        circuitBreaker: {
          minimumThroughput: 20,
          failureRateThreshold: 50,
        },
      },
    );

    await expect(client.call()).rejects.toThrow("Retry attempts exhausted");
    expect(attempts).toBe(2);
  });

  it("falls back after a timeout", async () => {
    const client = createClient(async () => new Promise<string>(() => undefined), {
      timeout: { perAttemptMs: 15 },
      fallback: {
        handler() {
          return "fallback";
        },
      },
    });

    await expect(client.call()).resolves.toBe("fallback");
  });

  it("applies timeout to shared dedupe work", async () => {
    const client = createClient(async () => new Promise<string>(() => undefined), {
      timeout: { perAttemptMs: 15 },
      dedupe: { key: () => "same" },
    });

    await expect(client.call()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("times out a hanging hedged attempt", async () => {
    const client = createClient(async () => new Promise<string>(() => undefined), {
      timeout: { perAttemptMs: 15 },
      hedge: { delay: 5 },
    });

    await expect(client.call()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("retries cache misses and serves the later hit", async () => {
    let attempts = 0;
    const client = createClient(
      () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("miss"));
        }

        return Promise.resolve("ok");
      },
      {
        cache: { key: () => "k", ttl: 1_000 },
        retry: {
          maxAttempts: 2,
          jitter: "none",
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryOn(outcome) {
            return outcome.status === "error";
          },
        },
      },
    );

    await expect(client.call()).resolves.toBe("ok");
    await expect(client.call()).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });
});
