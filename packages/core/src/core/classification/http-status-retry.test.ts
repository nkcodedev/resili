import { describe, expect, it } from "vitest";

import {
  createClient,
  RetryExceededError,
  TimeoutError,
  composeClassifier,
  resili,
} from "../../index";
import { AbortError } from "../errors";
import { httpClassifier, type Outcome } from "./index";

const RETRY = {
  maxAttempts: 3,
  backoff: "fixed" as const,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: "none" as const,
};

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const STATUS_RETRY_ON = (outcome: Outcome): boolean => {
  if (outcome.status === "error") {
    return true;
  }

  const status = (outcome.value as { readonly status?: unknown }).status;
  return typeof status === "number" && RETRYABLE_STATUSES.has(status);
};

describe("HTTP status retry safety (Option B narrow)", () => {
  it.each([200, 404, 408, 429, 500, 502, 503, 504] as const)(
    "does not auto-retry a resolved HTTP status %s under default classifier",
    async (status) => {
      let attempts = 0;
      const client = createClient(
        () => {
          attempts += 1;
          return Promise.resolve({ status });
        },
        { retry: RETRY },
      );

      await expect(client.call()).resolves.toEqual({ status });
      expect(attempts).toBe(1);
      await client.destroy();
    },
  );

  it("allows explicit retryOn to retry resolved 503 and 429", async () => {
    for (const status of [503, 429] as const) {
      let attempts = 0;
      const client = createClient(
        () => {
          attempts += 1;
          return Promise.resolve({ status });
        },
        {
          retry: {
            ...RETRY,
            retryOn: STATUS_RETRY_ON,
          },
        },
      );

      await expect(client.call()).rejects.toBeInstanceOf(RetryExceededError);
      expect(attempts).toBe(3);
      await client.destroy();
    }
  });

  it("allows a custom classifier to re-enable status retries", async () => {
    let attempts = 0;
    const client = createClient(
      () => {
        attempts += 1;
        return Promise.resolve({ status: 503 });
      },
      {
        retry: RETRY,
        classifier: composeClassifier(httpClassifier, {
          isRetryable(outcome, ctx) {
            if (outcome.status === "error") {
              return httpClassifier.isRetryable(outcome, ctx);
            }

            const status = (outcome.value as { readonly status?: unknown }).status;
            return status === 503;
          },
        }),
      },
    );

    await expect(client.call()).rejects.toBeInstanceOf(RetryExceededError);
    expect(attempts).toBe(3);
    await client.destroy();
  });

  it("preserves RetryExceededError when success-status retries exhaust", async () => {
    let attempts = 0;
    const client = createClient(
      () => {
        attempts += 1;
        return Promise.resolve({ status: 503 });
      },
      {
        retry: {
          ...RETRY,
          retryOn: STATUS_RETRY_ON,
        },
      },
    );

    const error = await client.call().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RetryExceededError);
    expect((error as RetryExceededError).lastError).toMatchObject({
      message: "Retry predicate requested retry for successful outcome.",
    });
    expect(attempts).toBe(3);
    await client.destroy();
  });

  it("keeps circuit-breaker failure counting for .status 503 and not for 429", async () => {
    let attempts = 0;
    const failing = createClient(
      () => {
        attempts += 1;
        return Promise.resolve({ status: 503 });
      },
      {
        circuitBreaker: {
          window: { type: "count", size: 4 },
          failureRateThreshold: 50,
          minimumThroughput: 2,
          resetTimeoutMs: 60_000,
        },
      },
    );

    await failing.call();
    await failing.call();
    await expect(failing.call()).rejects.toMatchObject({ code: "ERR_CIRCUIT_OPEN" });
    expect(attempts).toBe(2);
    await failing.destroy();

    attempts = 0;
    const rateLimited = createClient(
      () => {
        attempts += 1;
        return Promise.resolve({ status: 429 });
      },
      {
        circuitBreaker: {
          window: { type: "count", size: 4 },
          failureRateThreshold: 50,
          minimumThroughput: 2,
          resetTimeoutMs: 60_000,
        },
      },
    );

    await rateLimited.call();
    await rateLimited.call();
    await rateLimited.call();
    expect(attempts).toBe(3);
    await rateLimited.destroy();
  });

  it("does not retry caller abort", async () => {
    let attempts = 0;
    const client = resili(() => {
      attempts += 1;
      return Promise.reject(new AbortError({ reason: "caller" }));
    })
      .retry(RETRY)
      .build();

    await expect(
      client.execute(() => {
        attempts += 1;
        return Promise.reject(new AbortError({ reason: "caller" }));
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(attempts).toBe(1);
    await client.destroy();
  });

  it("still retries timeouts under the default classifier", async () => {
    let attempts = 0;
    const client = resili(async () => {
      attempts += 1;
      await new Promise(() => {
        /* hang until timeout */
      });
    })
      .timeout({ perAttemptMs: 5 })
      .retry({ ...RETRY, maxAttempts: 2 })
      .build();

    const error = await client.call().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RetryExceededError);
    expect((error as RetryExceededError).lastError).toBeInstanceOf(TimeoutError);
    expect(attempts).toBe(2);
    await client.destroy();
  });

  it("retries network errors only when metadata.idempotent is true", async () => {
    const makeError = (): Error & { code: string } =>
      Object.assign(new Error("reset"), { code: "ECONNRESET" });

    let attempts = 0;
    const unsafe = createClient(
      () => {
        attempts += 1;
        return Promise.reject(makeError());
      },
      { retry: RETRY },
    );
    await expect(unsafe.call()).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(attempts).toBe(1);
    await unsafe.destroy();

    attempts = 0;
    const safe = createClient(() => Promise.resolve("unused"), { retry: RETRY });
    await expect(
      safe.execute(
        () => {
          attempts += 1;
          return Promise.reject(makeError());
        },
        { metadata: { idempotent: true } },
      ),
    ).rejects.toBeInstanceOf(RetryExceededError);
    expect(attempts).toBe(3);
    await safe.destroy();
  });
});
