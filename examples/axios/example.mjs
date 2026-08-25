/**
 * Runnable locally. Not executed in CI.
 *
 * No credentials and no outbound network access required — the example starts a
 * local HTTP server that returns 503 twice before succeeding.
 */
import { createServer } from "node:http";

import axios from "axios";
import { createAxios } from "@resili/axios";

let requests = 0;

const server = createServer((req, res) => {
  requests += 1;

  if (requests < 3) {
    res.writeHead(503);
    res.end("unavailable");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, servedOnRequest: requests }));
});

await new Promise((resolve) => server.listen(0, resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// You own the axios instance. Resili never constructs one, so baseURL, headers,
// and interceptors stay yours to configure.
const instance = axios.create({
  baseURL,
  // axios rejects on non-2xx by default. Returning true here keeps the response
  // as a value so retryOn below can inspect the status instead.
  validateStatus: () => true,
});

const client = createAxios({
  axios: instance,
  timeout: { perAttemptMs: 2_000 },
  retry: {
    maxAttempts: 4,
    backoff: "exponential",
    baseDelayMs: 50,
    jitter: "none",
    retryOn(outcome) {
      return outcome.status === "success" && outcome.value.status >= 500;
    },
  },
});

const response = await client.get("/users");
console.log("status:", response.status, "body:", response.data);
console.log(`server saw ${requests} request(s)`);

// Verb helpers wrap the same pipeline: request, get, delete, post, put, patch.
const created = await client.post("/users", { name: "Ada Lovelace" });
console.log("post status:", created.status);

server.close();
