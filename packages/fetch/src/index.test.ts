import { describe, expect, it, vi } from "vitest";

import type { Outcome } from "@resili/core";
import { createFetch, type FetchImplementation } from "./index";

const RESPONSE = new Response("ok", { status: 200 });

describe("createFetch", () => {
  it("returns a fetch-compatible function that calls the injected fetch", async () => {
    const fetch = createFetchImplementation(() => Promise.resolve(RESPONSE));
    const resilientFetch = createFetch({ fetch });

    await expect(resilientFetch("https://example.com/users")).resolves.toBe(RESPONSE);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://example.com/users", expect.any(Object));
  });

  it("preserves RequestInit fields while overriding signal", async () => {
    let capturedInit: RequestInit | undefined;
    const callerController = new AbortController();
    const fetch = createFetchImplementation((_input, init) => {
      capturedInit = init;

      return Promise.resolve(RESPONSE);
    });
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
      signal: callerController.signal,
    };
    const resilientFetch = createFetch({ fetch });

    await resilientFetch(new URL("https://example.com/users"), init);

    expect(capturedInit).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.signal).not.toBe(callerController.signal);
    expect(init.signal).toBe(callerController.signal);
  });

  it("does not mutate caller RequestInit", async () => {
    const callerController = new AbortController();
    const init: RequestInit = Object.freeze({
      method: "GET",
      signal: callerController.signal,
    });
    const fetch = createFetchImplementation(() => Promise.resolve(RESPONSE));
    const resilientFetch = createFetch({ fetch });

    await resilientFetch("https://example.com/users", init);

    expect(init).toEqual({ method: "GET", signal: callerController.signal });
  });

  it("uses core fallback configuration", async () => {
    const fallbackResponse = new Response("fallback", { status: 200 });
    const failure = new Error("network failed");
    const fetch = createFetchImplementation(() => Promise.reject(failure));
    const resilientFetch = createFetch({
      fetch,
      fallback() {
        return fallbackResponse;
      },
    });

    await expect(resilientFetch("https://example.com/users")).resolves.toBe(fallbackResponse);
  });

  it("uses core retry configuration", async () => {
    let attempts = 0;
    const fetch = createFetchImplementation(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve(RESPONSE);
    });
    const resilientFetch = createFetch({
      fetch,
      retry: {
        maxAttempts: 2,
        jitter: "none",
        retryOn(outcome: Outcome) {
          return outcome.status === "error";
        },
      },
    });

    await expect(resilientFetch("https://example.com/users")).resolves.toBe(RESPONSE);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates fetch errors when no fallback handles them", async () => {
    const failure = new Error("network failed");
    const fetch = createFetchImplementation(() => Promise.reject(failure));
    const resilientFetch = createFetch({ fetch });

    await expect(resilientFetch("https://example.com/users")).rejects.toBe(failure);
  });

  it("subscribes to Core events and unsubscribes", async () => {
    const fetch = createFetchImplementation(() => Promise.resolve(RESPONSE));
    const resilientFetch = createFetch({ fetch });
    const seen: string[] = [];
    const unsubscribe = resilientFetch.on("RequestStarted", () => {
      seen.push("start");
    });

    await resilientFetch("https://example.com/users");
    expect(seen).toEqual(["start"]);

    unsubscribe();
    await resilientFetch("https://example.com/users");
    expect(seen).toEqual(["start"]);
  });

  it("destroy is idempotent and does not change caller cancellation", async () => {
    const fetch = createFetchImplementation(() => Promise.resolve(RESPONSE));
    const resilientFetch = createFetch({ fetch });

    await resilientFetch.destroy();
    await resilientFetch.destroy();

    const cancelled = createFetch({ fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled("https://example.com/users", { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).toHaveBeenCalledTimes(0);
    await cancelled.destroy();
  });
});

function createFetchImplementation(
  implementation: FetchImplementation,
): ReturnType<typeof vi.fn<FetchImplementation>> {
  return vi.fn<FetchImplementation>(implementation);
}
