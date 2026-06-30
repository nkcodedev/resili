import { describe, expect, it, vi } from "vitest";

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

describe("createAxios", () => {
  it("returns a callable axios-compatible function", async () => {
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });
    const config = Object.freeze({ url: "/users", method: "get" });

    await expect(axios(config)).resolves.toBe(RESPONSE);

    expect(axiosImplementation).toHaveBeenCalledTimes(1);
    expect(axiosImplementation).toHaveBeenCalledWith(expect.objectContaining(config));
  });

  it("supports request(config)", async () => {
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });

    await expect(axios.request({ url: "/users", method: "get" })).resolves.toBe(RESPONSE);

    expect(axiosImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/users", method: "get" }),
    );
  });

  it("supports get and delete helpers", async () => {
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });
    const config = Object.freeze({ headers: { accept: "application/json" } });

    await axios.get("/users", config);
    await axios.delete("/users/1", config);

    expect(axiosImplementation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ headers: config.headers, method: "get", url: "/users" }),
    );
    expect(axiosImplementation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headers: config.headers, method: "delete", url: "/users/1" }),
    );
  });

  it("supports post, put, and patch helpers", async () => {
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });
    const data = Object.freeze({ name: "Ada" });

    await axios.post("/users", data, { headers: { "content-type": "application/json" } });
    await axios.put("/users/1", data);
    await axios.patch("/users/1", data);

    expect(axiosImplementation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data, method: "post", url: "/users" }),
    );
    expect(axiosImplementation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data, method: "put", url: "/users/1" }),
    );
    expect(axiosImplementation).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ data, method: "patch", url: "/users/1" }),
    );
  });

  it("passes Resili signal and overrides caller signal", async () => {
    let capturedConfig: AxiosRequestConfig | undefined;
    const callerController = new AbortController();
    const axiosImplementation = createAxiosImplementation((config) => {
      capturedConfig = config;

      return Promise.resolve(RESPONSE);
    });
    const axios = createAxios({ axios: axiosImplementation });
    const config = Object.freeze({
      signal: callerController.signal,
      url: "/users",
    });

    await axios.request(config);

    expect(capturedConfig?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedConfig?.signal).not.toBe(callerController.signal);
    expect(config.signal).toBe(callerController.signal);
  });

  it("does not mutate caller config", async () => {
    const callerController = new AbortController();
    const config: AxiosRequestConfig = Object.freeze({
      signal: callerController.signal,
      url: "/users",
    });
    const axiosImplementation = createAxiosImplementation(() => Promise.resolve(RESPONSE));
    const axios = createAxios({ axios: axiosImplementation });

    await axios.request(config);

    expect(config).toEqual({ signal: callerController.signal, url: "/users" });
  });

  it("uses core fallback configuration", async () => {
    const fallbackResponse: AxiosResponse = Object.freeze({
      data: { fallback: true },
      status: 200,
      statusText: "OK",
      config: Object.freeze({ url: "/fallback" }),
    });
    const axiosImplementation = createAxiosImplementation(() =>
      Promise.reject(new Error("network failed")),
    );
    const axios = createAxios({
      axios: axiosImplementation,
      fallback() {
        return fallbackResponse;
      },
    });

    await expect(axios.get("/users")).resolves.toBe(fallbackResponse);
  });

  it("uses core retry configuration", async () => {
    let attempts = 0;
    const axiosImplementation = createAxiosImplementation(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new Error("retryable")) : Promise.resolve(RESPONSE);
    });
    const axios = createAxios({
      axios: axiosImplementation,
      retry: {
        maxAttempts: 2,
        jitter: "none",
        retryOn(outcome) {
          return outcome.status === "error";
        },
      },
    });

    await expect(axios.get("/users")).resolves.toBe(RESPONSE);

    expect(axiosImplementation).toHaveBeenCalledTimes(2);
  });

  it("propagates axios errors when no fallback handles them", async () => {
    const failure = new Error("network failed");
    const axiosImplementation = createAxiosImplementation(() => Promise.reject(failure));
    const axios = createAxios({ axios: axiosImplementation });

    await expect(axios.get("/users")).rejects.toBe(failure);
  });
});

function createAxiosImplementation(
  implementation: AxiosImplementation,
): ReturnType<typeof vi.fn<AxiosImplementation>> {
  return vi.fn<AxiosImplementation>(implementation);
}
