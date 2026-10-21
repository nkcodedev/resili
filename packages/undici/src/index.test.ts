import { describe, expect, it, vi } from "vitest";

import { ConfigurationError, type Outcome } from "@resili/core";
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

describe("createUndici", () => {
  it("returns a request function that calls the injected implementation", async () => {
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const resilientRequest = createUndici({ request });
    const options = Object.freeze({
      method: "GET",
      origin: "https://api.example.com",
      path: "/users",
    });

    await expect(resilientRequest(options)).resolves.toBe(RESPONSE);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining(options));
  });

  it("preserves request fields while overriding signal", async () => {
    let capturedOptions: UndiciRequestOptions | undefined;
    const callerController = new AbortController();
    const request = createUndiciImplementation((options) => {
      capturedOptions = options;

      return Promise.resolve(RESPONSE);
    });
    const options = Object.freeze({
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
      origin: "https://api.example.com",
      path: "/users",
      signal: callerController.signal,
    });
    const resilientRequest = createUndici({ request });

    await resilientRequest(options);

    expect(capturedOptions).toMatchObject({
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
      origin: "https://api.example.com",
      path: "/users",
    });
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions?.signal).not.toBe(callerController.signal);
    expect(options.signal).toBe(callerController.signal);
  });

  it("does not mutate caller options", async () => {
    const callerController = new AbortController();
    const options: UndiciRequestOptions = Object.freeze({
      origin: "https://api.example.com",
      path: "/users",
      signal: callerController.signal,
    });
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const resilientRequest = createUndici({ request });

    await resilientRequest(options);

    expect(options).toEqual({
      origin: "https://api.example.com",
      path: "/users",
      signal: callerController.signal,
    });
  });

  it("uses core fallback configuration", async () => {
    const fallbackResponse: UndiciResponse = Object.freeze({
      statusCode: 200,
      body: "fallback",
    });
    const request = createUndiciImplementation(() => Promise.reject(new Error("network failed")));
    const resilientRequest = createUndici({
      request,
      fallback() {
        return fallbackResponse;
      },
    });

    await expect(
      resilientRequest({ origin: "https://api.example.com", path: "/users" }),
    ).resolves.toBe(fallbackResponse);
  });

  it("uses core retry configuration", async () => {
    let attempts = 0;
    const request = createUndiciImplementation(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve(RESPONSE);
    });
    const resilientRequest = createUndici({
      request,
      retry: {
        maxAttempts: 2,
        jitter: "none",
        retryOn(outcome: Outcome) {
          return outcome.status === "error";
        },
      },
    });

    await expect(
      resilientRequest({ origin: "https://api.example.com", path: "/users" }),
    ).resolves.toBe(RESPONSE);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates request errors when no fallback handles them", async () => {
    const failure = new Error("network failed");
    const request = createUndiciImplementation(() => Promise.reject(failure));
    const resilientRequest = createUndici({ request });

    await expect(
      resilientRequest({ origin: "https://api.example.com", path: "/users" }),
    ).rejects.toBe(failure);
  });

  it("subscribes to Core events and unsubscribes", async () => {
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const resilientRequest = createUndici({ request });
    const seen: string[] = [];
    const unsubscribe = resilientRequest.on("RequestStarted", () => {
      seen.push("start");
    });

    await resilientRequest({ origin: "https://api.example.com", path: "/users" });
    expect(seen).toEqual(["start"]);

    unsubscribe();
    await resilientRequest({ origin: "https://api.example.com", path: "/users" });
    expect(seen).toEqual(["start"]);
  });

  it("destroy is idempotent and does not change caller cancellation", async () => {
    const request = createUndiciImplementation(() => Promise.resolve(RESPONSE));
    const resilientRequest = createUndici({ request });

    await resilientRequest.destroy();
    await resilientRequest.destroy();

    const cancelled = createUndici({ request });
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled({ origin: "https://api.example.com", path: "/users", signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request).toHaveBeenCalledTimes(0);
    await cancelled.destroy();
  });

  it.each(["GET", "POST"] as const)(
    "does not auto-retry a resolved statusCode 503 for %s without retryOn",
    async (method) => {
      let attempts = 0;
      const resilientRequest = createUndici({
        request: () => {
          attempts += 1;
          return Promise.resolve({
            statusCode: 503,
            headers: Object.freeze({}),
            body: "unavailable",
          });
        },
        retry: {
          maxAttempts: 3,
          backoff: "fixed",
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: "none",
        },
      });

      const response = await resilientRequest({
        origin: "https://api.example.com",
        path: "/orders",
        method,
      });
      expect(response.statusCode).toBe(503);
      expect(attempts).toBe(1);
      await resilientRequest.destroy();
    },
  );

  it("retries statusCode 503 when retryOn opts in", async () => {
    let attempts = 0;
    const resilientRequest = createUndici({
      request: () => {
        attempts += 1;
        return Promise.resolve({
          statusCode: 503,
          headers: Object.freeze({}),
          body: "unavailable",
        });
      },
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: "none",
        retryOn(outcome: Outcome) {
          if (outcome.status === "error") {
            return true;
          }
          return outcome.value.statusCode === 503;
        },
      },
    });

    await expect(
      resilientRequest({ origin: "https://api.example.com", path: "/orders", method: "POST" }),
    ).rejects.toMatchObject({
      code: "ERR_RETRY_EXCEEDED",
    });
    expect(attempts).toBe(3);
    await resilientRequest.destroy();
  });

  it("rejects missing, null, and partial request configuration", () => {
    expect(() => createUndici(undefined as never)).toThrow(ConfigurationError);
    expect(() => createUndici(null as never)).toThrow(ConfigurationError);
    expect(() => createUndici([] as never)).toThrow(ConfigurationError);
    expect(() => createUndici({} as never)).toThrow(ConfigurationError);
    expect(() => createUndici({ request: null } as never)).toThrow(ConfigurationError);
    expect(() => createUndici({ request: {} } as never)).toThrow(ConfigurationError);
  });
});

function createUndiciImplementation(
  implementation: UndiciImplementation,
): ReturnType<typeof vi.fn<UndiciImplementation>> {
  return vi.fn<UndiciImplementation>(implementation);
}
