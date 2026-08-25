# Resili

> TypeScript-first resilience toolkit for production Node.js services.

[![CI](https://img.shields.io/badge/ci-placeholder-lightgrey.svg)](#)
[![version](https://img.shields.io/badge/version-0.1.0--alpha.1-blue.svg)](packages/core/package.json)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![typescript](https://img.shields.io/badge/types-TypeScript-blue.svg)](#)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](packages/core/package.json)
[![core dependencies](https://img.shields.io/badge/core%20dependencies-zero-brightgreen.svg)](packages/core/package.json)

Resili wraps unreliable work — HTTP calls, SDK calls, database calls, queues, or any async operation — with composable reliability policies.

Use it to bound latency, retry transient failures, stop calls to unhealthy dependencies, isolate concurrency, reduce duplicate work, cache safe reads, and observe policy behavior through typed events and metrics.

```ts
import { resili } from "@resili/core";

const users = resili((id: string) => fetch(`https://api.example.com/users/${id}`))
  .timeout({ perAttemptMs: 1_000 })
  .retry({ maxAttempts: 3, backoff: "exponential", jitter: "none" })
  .circuitBreaker({ minimumThroughput: 10 })
  .build();

const response = await users.call("42");
```

## Table of Contents

- [Why Resili](#why-resili)
- [Features](#features)
- [Built-in Policies at a glance](#built-in-policies-at-a-glance)
- [Installation](#installation)
- [30-second Quick Start](#30-second-quick-start)
- [Builder API](#builder-api)
- [Built-in Policies](#built-in-policies)
- [Policy Execution Order](#policy-execution-order)
- [Adapters](#adapters)
- [Plugins](#plugins)
- [Architecture](#architecture)
- [Development Status](#development-status)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why Resili

Distributed systems fail in ordinary, repeatable ways: slow downstreams, transient network errors, overload, cascading failures, duplicate in-flight requests, repeated reads, and partial outages.

Resili gives those failure modes explicit, typed, testable policy boundaries.

- **One abstraction:** wrap any async operation, not just HTTP.
- **TypeScript-first:** operation argument and return types flow through clients.
- **Composable policies:** retry, timeout, circuit breaker, cache, dedupe, hedge, rate limit, bulkhead, and fallback policies can run together in a deterministic order.
- **Observable by design:** policies emit typed lifecycle events and record low-cardinality metrics through a framework-neutral contract.
- **Small core:** no provider SDKs, exporters, or transport dependencies in `@resili/core`.
- **Adapter packages:** fetch, Axios-compatible, and Undici-compatible wrappers live outside core.

## Features

| Capability                 | Package                 | Status    | Notes                                                     |
| -------------------------- | ----------------------- | --------- | --------------------------------------------------------- |
| Fluent builder             | `@resili/core`          | Available | `resili(operation).retry().timeout(...).build()`          |
| Declarative client factory | `@resili/core`          | Available | `createClient(operation, config)`                         |
| Retry                      | `@resili/core`          | Available | Fixed/exponential backoff, deterministic `jitter: "none"` |
| Timeout                    | `@resili/core`          | Available | Per-attempt timeout with context signal fork              |
| Circuit breaker            | `@resili/core`          | Available | In-memory per-key breaker state                           |
| Bulkhead                   | `@resili/core`          | Available | In-memory concurrency and queue limits                    |
| Rate limiter               | `@resili/core`          | Available | Token bucket and sliding window, reject mode              |
| Fallback                   | `@resili/core`          | Available | Async fallback handlers and predicates                    |
| Hedged requests            | `@resili/core`          | Available | Starts a delayed duplicate attempt for safe operations    |
| Request deduplication      | `@resili/core`          | Available | Shares concurrent same-key in-flight work                 |
| Memory cache               | `@resili/core`          | Available | Per-client TTL cache with lazy expiry and FIFO eviction   |
| Typed events               | `@resili/core`          | Available | Runtime subscriptions with typed event payloads           |
| Metrics contract           | `@resili/core`          | Available | `MetricsRecorder` interface and `noopMetrics`             |
| Plugin contracts/runtime   | `@resili/core`          | Available | Register policies/events/service overrides                |
| Fetch adapter              | `@resili/fetch`         | Available | Native fetch-compatible wrapper                           |
| Axios adapter              | `@resili/axios`         | Available | Minimal Axios-compatible structural wrapper               |
| Undici adapter             | `@resili/undici`        | Available | Minimal Undici-compatible request wrapper                 |
| LLM foundation             | `@resili/llm`           | Alpha     | Provider-neutral usage, cost, budget, and LLM telemetry   |
| OpenAI LLM adapter         | `@resili/llm-openai`    | Alpha     | Chat Completions provider for `@resili/llm`               |
| Anthropic LLM adapter      | `@resili/llm-anthropic` | Alpha     | Messages API provider for `@resili/llm`                   |
| Gemini LLM adapter         | `@resili/llm-gemini`    | Alpha     | generateContent provider for `@resili/llm`                |

## Built-in Policies at a glance

| Policy                | Use it when you need to                           | Default scope/state                         |
| --------------------- | ------------------------------------------------- | ------------------------------------------- |
| Fallback              | Return an alternate value for handled failures    | Per logical call                            |
| Memory Cache          | Reuse successful completed values for a short TTL | Per built client, in-memory `Map`           |
| Retry                 | Retry transient failures                          | Per logical call                            |
| Circuit Breaker       | Stop calling unhealthy dependencies               | Per built client, in-memory per key         |
| Timeout               | Bound one downstream attempt                      | Per attempt `AbortSignal` fork              |
| Request Deduplication | Share concurrent same-key in-flight work          | Per built client, in-memory in-flight table |
| Hedged Requests       | Reduce tail latency for safe/idempotent reads     | Per logical call                            |
| Rate Limiter          | Limit request rate                                | Per built client, in-memory per key         |
| Bulkhead              | Bound concurrency and queue depth                 | Per built client, in-memory per key         |

## Installation

```bash
pnpm add @resili/core
```

Adapter packages are installed separately:

```bash
pnpm add @resili/fetch
pnpm add @resili/axios
pnpm add @resili/undici
```

Resili targets Node.js 20 or newer and ships TypeScript declarations.

## 30-second Quick Start

```ts
import { createClient } from "@resili/core";

const client = createClient(
  async (id: string) => {
    const response = await fetch(`https://api.example.com/users/${id}`);
    return response.json() as Promise<{ id: string; name: string }>;
  },
  {
    timeout: { perAttemptMs: 1_000 },
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitter: "none",
    },
    circuitBreaker: {
      minimumThroughput: 10,
      failureRateThreshold: 0.5,
      resetTimeoutMs: 30_000,
    },
  },
);

const user = await client.call("42");
```

`client.call(...args)` preserves the wrapped operation signature. `client.execute(fn, init?)` runs context-aware work through the same policy pipeline.

## Builder API

Use the fluent builder when configuration is close to the operation:

```ts
import { resili } from "@resili/core";

const client = resili((url: string) => fetch(url))
  .retry({ maxAttempts: 3, jitter: "none" })
  .timeout({ perAttemptMs: 2_000 })
  .bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  .rateLimiter({ limit: 100, intervalMs: 1_000 })
  .fallback({
    handler() {
      return new Response("fallback", { status: 200 });
    },
  })
  .build();

const response = await client.call("https://api.example.com/health");
```

Use `createClient` when you prefer declarative config:

```ts
import { createClient } from "@resili/core";

const client = createClient((url: string) => fetch(url), {
  retry: { maxAttempts: 2, jitter: "none" },
  timeout: 750,
  rateLimiter: { limit: 50, intervalMs: 1_000 },
});
```

### Custom policies

```ts
import { definePolicy } from "@resili/core";

const loggingPolicy = definePolicy({
  name: "logging",
  order: { before: "timeout" },
  create() {
    return {
      name: "logging",
      order: { before: "timeout" },
      async execute(ctx, next) {
        console.log("request", ctx.requestId);
        return await next(ctx);
      },
    };
  },
});

const client = resili((url: string) => fetch(url))
  .policy(loggingPolicy)
  .build();
```

## Built-in Policies

### Retry

```ts
.retry({
  maxAttempts: 3,
  backoff: "fixed",
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitter: "none",
})
```

Supported today: fixed/exponential backoff, max attempts, delay budgets, `retryOn`, and `respectRetryAfter`. Deterministic `jitter: "none"` is supported; other jitter modes are intentionally rejected until deterministic randomization exists.

### Timeout

```ts
.timeout({ perAttemptMs: 1_000 })
// or
.timeout(1_000)
```

Timeouts fork the execution context with an `AbortSignal` for each attempt.

### Circuit Breaker

```ts
.circuitBreaker({
  minimumThroughput: 10,
  failureRateThreshold: 0.5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 2,
})
```

The current implementation stores breaker state in memory per client instance.

### Bulkhead

```ts
.bulkhead({
  maxConcurrent: 25,
  maxQueue: 100,
  queueTimeoutMs: 500,
})
```

Bulkheads bound concurrency and queue depth per key.

### Rate Limiter

```ts
.rateLimiter({
  strategy: "token-bucket",
  limit: 100,
  intervalMs: 1_000,
  burst: 200,
  onLimit: "reject",
})
```

Supported today: token bucket, sliding window, per-key in-memory state, and reject mode.

### Fallback

```ts
.fallback({
  fallbackOn(error) {
    return error instanceof Error;
  },
  handler() {
    return new Response("temporary fallback", { status: 200 });
  },
})
```

Fallback handlers may be synchronous or asynchronous.

### Hedged Requests

```ts
.hedge({
  delay: 100,
})
```

Hedged requests start the original execution immediately and, if no acceptable result completes before the configured delay, start a second execution. Use hedging only for safe or idempotent operations because it can increase downstream load.

### Request Deduplication

```ts
.dedupe({
  key: (id: string) => id,
})
```

Request deduplication shares concurrent same-key in-flight executions. It does not cache completed results.

### Memory Cache

```ts
.cache({
  key: (id: string) => id,
  ttl: 5_000,
})
```

Memory cache stores successful completed values in a per-client in-memory cache. Entries expire lazily by TTL and are evicted using bounded FIFO behavior.

## Policy Execution Order

Resili composes policies in a deterministic onion-style pipeline. Lower policies are reached only if earlier policies call downstream.

```text
Fallback
↓
Memory Cache
↓
Retry
↓
Circuit Breaker
↓
Timeout
↓
Request Deduplication
↓
Hedged Requests
↓
Rate Limiter
↓
Bulkhead
↓
Operation
```

This order matters. For example, a cache hit bypasses retry, timeout, dedupe, hedge, rate limiting, bulkhead admission, and the wrapped operation. A cache miss continues into the normal downstream pipeline.

## Adapters

Adapters are thin transport wrappers around `@resili/core`. They do not classify HTTP status codes or transform response bodies.

### Fetch

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  circuitBreaker: { minimumThroughput: 10 },
});

const response = await resilientFetch("https://api.example.com/users", {
  method: "GET",
});
```

The fetch adapter shallow-copies `RequestInit` and passes Resili's context signal as `init.signal`.

### Axios-compatible

```ts
import { createAxios, type AxiosImplementation, type AxiosRequestConfig } from "@resili/axios";

const axiosImplementation: AxiosImplementation = async <T, D>(config: AxiosRequestConfig<D>) => ({
  data: { ok: true } as T,
  status: 200,
  statusText: "OK",
  config,
});

const axios = createAxios({
  axios: axiosImplementation,
  retry: { maxAttempts: 2, jitter: "none" },
  timeout: { perAttemptMs: 1_000 },
});

const response = await axios.get("/users");
```

The Axios adapter provides a minimal structural API: callable `axios(config)`, `request`, `get`, `delete`, `post`, `put`, and `patch`. It does not implement interceptors, transforms, cancel tokens, or `axios.create()`.

### Undici-compatible

```ts
import { createUndici, type UndiciImplementation } from "@resili/undici";

const requestImplementation: UndiciImplementation = async (options) => ({
  statusCode: 200,
  headers: {},
  body: `requested ${options.path}`,
});

const request = createUndici({
  request: requestImplementation,
  retry: { maxAttempts: 2, jitter: "none" },
});

const response = await request({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
});
```

The Undici adapter is a minimal request wrapper. It does not implement Agent, Pool, Dispatcher, MockAgent, ProxyAgent, WebSocket, streaming helpers, or body handling.

## Plugins

Plugins bundle setup-time policy registration, event subscriptions, and service overrides.

```ts
import { definePlugin, definePolicy, resili } from "@resili/core";

const auditPlugin = definePlugin({
  name: "audit",
  version: "1.0.0",
  apiVersion: "1.0.0",
  setup(ctx) {
    ctx.on("RequestCompleted", (event) => {
      console.log(event.operationName, event.status);
    });

    ctx.registerPolicy(
      definePolicy({
        name: "audit-policy",
        order: { before: "timeout" },
        create() {
          return {
            name: "audit-policy",
            order: { before: "timeout" },
            execute(_ctx, next) {
              return next(_ctx);
            },
          };
        },
      }),
    );

    return { name: "audit" };
  },
});

const client = resili((url: string) => fetch(url))
  .use(auditPlugin)
  .build();
```

Plugin installation supports dependency validation, priority ordering, setup execution, policy registration, event registration, store/clock/metrics overrides, and reverse-order disposal on client destroy.

## Architecture

Resili is built around a small set of runtime contracts:

```text
operation args
  ↓
Client.call(...args)
  ↓
Context creation
  ↓
Pipeline.execute(ctx)
  ↓
Policies in canonical order
  fallback → cache → retry → circuit-breaker → timeout → dedupe → hedge → rate-limiter → bulkhead
  ↓
wrapped operation / adapter
```

Core concepts:

- **Client** — immutable wrapper around an operation and compiled policy pipeline.
- **Context** — immutable per-execution metadata, attempt number, deadline, cancellation signal, and policy metadata.
- **Policy** — middleware-style unit that can observe, wrap, short-circuit, retry, time-box, or coordinate downstream work.
- **Pipeline** — deterministic policy ordering with onion-style execution and stable relative anchors.
- **Events** — typed lifecycle notifications emitted by clients and policies.
- **Metrics** — framework-neutral counters, gauges, and histograms recorded through `MetricsRecorder`.
- **Adapters** — package-level wrappers that turn transport APIs into Resili operations.
- **Plugins** — setup-time extension points for policies, events, metrics, state stores, clocks, and disposal.

The core package has no runtime dependencies. Transport integrations, exporters, and ecosystem-specific behavior belong in adapter or plugin packages.

## Development Status

Resili is under active development. The core runtime, built-in policies, plugin runtime, public entry points, typed events, metrics contracts, and minimal fetch/Axios/Undici adapters are implemented and tested in this repository.

Current package version placeholders are still pre-1.0; publishing and release automation are intentionally separate from the runtime implementation.

## Roadmap

| Version | Theme                             | Focus                                                                 |
| ------- | --------------------------------- | --------------------------------------------------------------------- |
| v0.2    | Intelligent Request Management    | Hedged requests, request deduplication, memory cache                  |
| v0.3    | Policy Composition                | Composition ergonomics, policy interaction hardening, advanced config |
| v0.4    | Playground & Profiles             | Interactive examples, reusable policy profiles, production recipes    |
| v1.0    | Stable API + Distributed adapters | Stable public API, distributed state adapters, release guarantees     |

## Contributing

This repository uses pnpm workspaces and TypeScript project references.

```bash
pnpm install
pnpm lint
pnpm -r typecheck
pnpm test
pnpm -r build
pnpm --filter @resili/core api:check
```

Development rules are documented in [`AGENTS.md`](AGENTS.md). Architecture and API decisions live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/API_SPECIFICATION.md`](docs/API_SPECIFICATION.md), and [`docs/INTERNAL_DESIGN.md`](docs/INTERNAL_DESIGN.md).

## Maintainer

Created and maintained by **Nitin Kaushal**.

- GitHub: https://github.com/nkcodedev
- Email: nkcodedev.chd@gmail.com

If you find the project useful, please consider starring the repository.

## License

MIT © Nitin Kaushal and contributors.
