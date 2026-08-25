/**
 * Runnable locally. Not executed in CI.
 *
 * No credentials and no outbound network access required — the example starts a
 * local HTTP server that returns 503 twice before succeeding.
 */
import { createServer } from "node:http";

import { request } from "undici";
import { createUndici } from "@resili/undici";

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
const origin = `http://127.0.0.1:${server.address().port}`;

// retryOn is synchronous, so it cannot drain the body of a response it discards.
// Undici requires every body to be consumed or the connection leaks, so drain it
// in the injected implementation instead.
async function requestAndDrainFailures(options) {
  const response = await request(options);

  if (response.statusCode >= 500) {
    await response.body.dump();
  }

  return response;
}

// You inject the request function. Note that undici reports the status as
// statusCode, not status.
const client = createUndici({
  request: requestAndDrainFailures,
  timeout: { perAttemptMs: 2_000 },
  retry: {
    maxAttempts: 4,
    backoff: "exponential",
    baseDelayMs: 50,
    jitter: "none",
    retryOn(outcome) {
      return outcome.status === "success" && outcome.value.statusCode >= 500;
    },
  },
});

const response = await client({ origin, path: "/users", method: "GET" });
console.log("statusCode:", response.statusCode, "body:", await response.body.json());
console.log(`server saw ${requests} request(s)`);

server.close();
