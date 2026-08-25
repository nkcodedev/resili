/**
 * Runnable locally. Not executed in CI.
 *
 * No credentials and no outbound network access required — the example starts a
 * local HTTP server that returns 503 twice before succeeding.
 */
import { createServer } from "node:http";

import { createFetch } from "@resili/fetch";

let requests = 0;

const server = createServer((req, res) => {
  requests += 1;

  if (requests < 3) {
    res.writeHead(503, { "retry-after": "0" });
    res.end("unavailable");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, servedOnRequest: requests }));
});

await new Promise((resolve) => server.listen(0, resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// HTTP status codes are NOT failures by default: the adapter returns the
// Response, so a 503 looks like success to the pipeline. Opt in with retryOn.
const fetchWithResilience = createFetch({
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

const response = await fetchWithResilience(`${baseUrl}/users`);
console.log("status:", response.status, "body:", await response.json());
console.log(`server saw ${requests} request(s)`);

// The adapter replaces init.signal with the Resili context signal and exposes no
// per-call options, so a caller signal passed here would have no effect. Wrap the
// call with @resili/core directly when you need caller cancellation.

server.close();
