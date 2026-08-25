import { describe, expect, it, vi } from "vitest";

import { AbortError, TimeoutError, type Outcome } from "@resili/core";
import {
  createUndici,
  type UndiciImplementation,
  type UndiciRequestOptions,
  type UndiciResponse,
} from "./index";

const RESPONSE: UndiciResponse = Object.freeze({
  statusCode: 200,
  headers: Object.freeze({}),
  body: "ok",
});

const ORIGIN = "https://api.example.com";

describe("createUndici caller cancellation", () => {
  it("does not invoke request when the caller signal is already aborted", async () => {
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const send = createUndici({ request });
    const controller = new AbortController();
    controller.abort();

    await expect(
      send({ origin: ORIGIN, path: "/users", signal: controller.signal }),
    ).rejects.toSatisfy(isCancellation);

    expect(request).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request through the composed context signal", async () => {
    const seen = createDeferred<AbortSignal>();
    const request = createUndiciImplementation((options) => {
      const signal = options.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const send = createUndici({
      request,
      retry: { maxAttempts: 3, jitter: "none" },
    });
    const controller = new AbortController();
    const pending = send({ origin: ORIGIN, path: "/users", signal: controller.signal });
    const underlying = await seen.promise;

    expect(underlying).not.toBe(controller.signal);
    expect(underlying.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    expect(underlying.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request after abort during retry backoff", async () => {
    let calls = 0;
    const firstFailed = createDeferred<true>();
    const request = createUndiciImplementation(() => {
      calls += 1;
      if (calls === 1) {
        firstFailed.resolve(true);

        return Promise.reject(new Error("retryable"));
      }

      return Promise.resolve(RESPONSE);
    });
    const send = createUndici({
      request,
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        baseDelayMs: 40,
        maxDelayMs: 40,
        jitter: "none",
        retryOn(outcome: Outcome) {
          return (
            outcome.status === "error" &&
            outcome.error instanceof Error &&
            outcome.error.message === "retryable"
          );
        },
      },
    });
    const controller = new AbortController();
    const pending = send({ origin: ORIGIN, path: "/users", signal: controller.signal });

    await firstFailed.promise;
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    expect(calls).toBe(1);
  });

  it("times out hanging work when the caller provides no signal", async () => {
    const seen = createDeferred<AbortSignal>();
    const request = createUndiciImplementation((options) => {
      const signal = options.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const send = createUndici({
      request,
      timeout: { perAttemptMs: 20 },
    });
    const pending = send({ origin: ORIGIN, path: "/users" });
    const underlying = await seen.promise;

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(underlying.aborted).toBe(true);
  });

  it("keeps caller-abort semantics when abort wins the race with a later timeout", async () => {
    const seen = createDeferred<AbortSignal>();
    const request = createUndiciImplementation((options) => {
      const signal = options.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const send = createUndici({
      request,
      timeout: { perAttemptMs: 60_000 },
    });
    const controller = new AbortController();
    const pending = send({ origin: ORIGIN, path: "/users", signal: controller.signal });
    await seen.promise;
    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    await expect(pending).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it("keeps timeout semantics when timeout completes before a later caller abort", async () => {
    const seen = createDeferred<AbortSignal>();
    const request = createUndiciImplementation((options) => {
      const signal = options.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const send = createUndici({
      request,
      timeout: { perAttemptMs: 20 },
    });
    const controller = new AbortController();
    const pending = send({ origin: ORIGIN, path: "/users", signal: controller.signal });
    await seen.promise;

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    controller.abort();
  });

  it("still retries ordinary errors when the caller does not abort", async () => {
    let attempts = 0;
    const request = createUndiciImplementation(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve(RESPONSE);
    });
    const send = createUndici({
      request,
      retry: {
        maxAttempts: 3,
        jitter: "none",
        retryOn(outcome: Outcome) {
          return outcome.status === "error";
        },
      },
    });

    await expect(send({ origin: ORIGIN, path: "/users" })).resolves.toBe(RESPONSE);
    expect(attempts).toBe(2);
  });

  it("does not mutate caller options.signal", async () => {
    const controller = new AbortController();
    const options: UndiciRequestOptions = Object.freeze({
      origin: ORIGIN,
      path: "/users",
      signal: controller.signal,
    });
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const send = createUndici({ request });

    await send(options);

    expect(options.signal).toBe(controller.signal);
  });

  it("isolates cancellation across concurrent calls on one adapter", async () => {
    const request = createUndiciImplementation((options) => {
      const signal = options.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      if (options.path === "/a") {
        return waitForAbort(signal);
      }

      return Promise.resolve(RESPONSE);
    });
    const send = createUndici({ request });
    const controllerA = new AbortController();
    const pendingA = send({ origin: ORIGIN, path: "/a", signal: controllerA.signal });
    const pendingB = send({ origin: ORIGIN, path: "/b" });

    controllerA.abort();

    await expect(pendingA).rejects.toSatisfy(isCancellation);
    await expect(pendingB).resolves.toBe(RESPONSE);
  });
});

function createUndiciImplementation(
  implementation: UndiciImplementation,
): ReturnType<typeof vi.fn<UndiciImplementation>> {
  return vi.fn<UndiciImplementation>(implementation);
}

function isCancellation(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };

    if (signal.aborted) {
      fail();

      return;
    }

    signal.addEventListener("abort", fail, { once: true });
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}
