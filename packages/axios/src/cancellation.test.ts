import { describe, expect, it, vi } from "vitest";

import { AbortError, TimeoutError, type Outcome } from "@resili/core";
import {
  createAxios,
  type AxiosImplementation,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "./index";

const RESPONSE: AxiosResponse<{ readonly ok: true }> = Object.freeze({
  data: { ok: true },
  status: 200,
  statusText: "OK",
  headers: Object.freeze({}),
  config: Object.freeze({}),
});

describe("createAxios caller cancellation", () => {
  it("does not invoke axios when the caller signal is already aborted", async () => {
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });
    const controller = new AbortController();
    controller.abort();

    await expect(axios.get("/users", { signal: controller.signal })).rejects.toSatisfy(
      isCancellation,
    );

    expect(axiosImplementation).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request through the composed context signal", async () => {
    const seen = createDeferred<AbortSignal>();
    const axiosImplementation = createAxiosImplementation((config) => {
      const signal = config.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      retry: { maxAttempts: 3, jitter: "none" },
    });
    const controller = new AbortController();
    const pending = axios.request({ url: "/users", signal: controller.signal });
    const underlying = await seen.promise;

    expect(underlying).not.toBe(controller.signal);
    expect(underlying.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    expect(underlying.aborted).toBe(true);
    expect(axiosImplementation).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request after abort during retry backoff", async () => {
    let calls = 0;
    const firstFailed = createDeferred<true>();
    const axiosImplementation = createAxiosImplementation(() => {
      calls += 1;
      if (calls === 1) {
        firstFailed.resolve(true);

        return Promise.reject(new Error("retryable"));
      }

      return Promise.resolve(RESPONSE);
    });
    const axios = createAxios({
      axios: axiosImplementation,
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
    const pending = axios.get("/users", { signal: controller.signal });

    await firstFailed.promise;
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    expect(calls).toBe(1);
  });

  it("times out hanging work when the caller provides no signal", async () => {
    const seen = createDeferred<AbortSignal>();
    const axiosImplementation = createAxiosImplementation((config) => {
      const signal = config.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      timeout: { perAttemptMs: 20 },
    });
    const pending = axios.get("/users");
    const underlying = await seen.promise;

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(underlying.aborted).toBe(true);
  });

  it("keeps caller-abort semantics when abort wins the race with a later timeout", async () => {
    const seen = createDeferred<AbortSignal>();
    const axiosImplementation = createAxiosImplementation((config) => {
      const signal = config.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      timeout: { perAttemptMs: 60_000 },
    });
    const controller = new AbortController();
    const pending = axios.get("/users", { signal: controller.signal });
    await seen.promise;
    controller.abort();

    await expect(pending).rejects.toSatisfy(isCancellation);
    await expect(pending).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it("keeps timeout semantics when timeout completes before a later caller abort", async () => {
    const seen = createDeferred<AbortSignal>();
    const axiosImplementation = createAxiosImplementation((config) => {
      const signal = config.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      seen.resolve(signal);

      return waitForAbort(signal);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      timeout: { perAttemptMs: 20 },
    });
    const controller = new AbortController();
    const pending = axios.get("/users", { signal: controller.signal });
    await seen.promise;

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    controller.abort();
  });

  it("still retries ordinary errors when the caller does not abort", async () => {
    let attempts = 0;
    const axiosImplementation = createAxiosImplementation(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve(RESPONSE);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      retry: {
        maxAttempts: 3,
        jitter: "none",
        retryOn(outcome: Outcome) {
          return outcome.status === "error";
        },
      },
    });

    await expect(axios.get("/users")).resolves.toBe(RESPONSE);
    expect(attempts).toBe(2);
  });

  it("does not mutate caller config.signal", async () => {
    const controller = new AbortController();
    const config: AxiosRequestConfig = Object.freeze({
      signal: controller.signal,
      url: "/users",
    });
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });

    await axios.request(config);

    expect(config.signal).toBe(controller.signal);
  });

  it("isolates cancellation across concurrent calls on one adapter", async () => {
    const axiosImplementation = createAxiosImplementation((config) => {
      const signal = config.signal;
      if (signal === undefined) {
        return Promise.reject(new Error("missing signal"));
      }

      if (config.url === "/a") {
        return waitForAbort(signal);
      }

      return Promise.resolve(RESPONSE);
    });
    const axios = createAxios({ axios: axiosImplementation });
    const controllerA = new AbortController();
    const pendingA = axios.get("/a", { signal: controllerA.signal });
    const pendingB = axios.get("/b");

    controllerA.abort();

    await expect(pendingA).rejects.toSatisfy(isCancellation);
    await expect(pendingB).resolves.toBe(RESPONSE);
  });
});

function createAxiosImplementation(
  implementation: AxiosImplementation,
): ReturnType<typeof vi.fn<AxiosImplementation>> {
  return vi.fn<AxiosImplementation>(implementation);
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
