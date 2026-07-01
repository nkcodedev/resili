# Resili

> TypeScript-first resilience primitives for modern Node.js services.

[![CI](https://img.shields.io/badge/ci-placeholder-lightgrey.svg)](#)
[![npm](https://img.shields.io/badge/npm-0.0.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![typescript](https://img.shields.io/badge/types-TypeScript-blue.svg)](#)

Resili helps you wrap unreliable work — HTTP calls, SDK calls, database calls, queues, or any async operation — with predictable retry, timeout, circuit breaker, bulkhead, rate limiting, and fallback behavior.

It is built around small composable policies, immutable clients, typed events, and zero-runtime-dependency core abstractions.

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
- [Installation](#installation)
- [30-second Quick Start](#30-second-quick-start)
- [Builder API](#builder-api)
- [Built-in Policies](#built-in-policies)
- [Adapters](#adapters)
- [Plugins](#plugins)
- [Architecture](#architecture)
- [Development Status](#development-status)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why Resili

Distributed systems fail in boring, repetitive ways: slow downstreams, transient network errors, overload, cascading failures, and partial outages. Resili gives those failure modes explicit, typed, testable policy boundaries.

- **One abstraction:** wrap any async operation, not just HTTP.
- **Typed by default:** generic argument and return types flow through clients.
- **Policy composition:** canonical ordering prevents retry/timeout/circuit-breaker footguns.
- **Small core:** no provider SDKs, exporters, or transport dependencies in `@resili/core`.
- **Adapter packages:** fetch, Axios-compatible, and Undici-compatible wrappers live outside core.

## Features

| Capability                 | Package          | Status    | Notes                                                     |
| -------------------------- | ---------------- | --------- | --------------------------------------------------------- |
| Fluent builder             | `@resili/core`   | Available | `resili(operation).retry().timeout(...).build()`          |
| Declarative client factory | `@resili/core`   | Available | `createClient(operation, config)`                         |
| Retry                      | `@resili/core`   | Available | Fixed/exponential backoff, deterministic `jitter: "none"` |
| Timeout                    | `@resili/core`   | Available | Per-attempt timeout with context signal fork              |
| Circuit breaker            | `@resili/core`   | Available | In-memory per-key breaker state                           |
| Bulkhead                   | `@resili/core`   | Available | In-memory concurrency and queue limits                    |
| Rate limiter               | `@resili/core`   | Available | Token bucket and sliding window, reject mode              |
| Fallback                   | `@resili/core`   | Available | Async fallback handlers and predicates                    |
| Events                     | `@resili/core`   | Available | Typed runtime subscriptions                               |
| Metrics contract           | `@resili/core`   | Available | `MetricsRecorder` interface and `noopMetrics`             |
| Plugin contracts/runtime   | `@resili/core`   | Available | Register policies/events/service overrides                |
| Fetch adapter              | `@resili/fetch`  | Available | Native fetch-compatible wrapper                           |
| Axios adapter              | `@resili/axios`  | Available | Minimal Axios-compatible structural wrapper               |
| Undici adapter             | `@resili/undici` | Available | Minimal Undici-compatible request wrapper                 |

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

```text
operation args
  ↓
Client.call(...args)
  ↓
Pipeline.execute(ctx)
  ↓
Policies in canonical order
  fallback → retry → circuit-breaker → timeout → rate-limiter → bulkhead
  ↓
wrapped operation / adapter
```

Core concepts:

- **Client** — immutable wrapper around an operation and compiled policy pipeline.
- **Context** — per-execution request metadata, attempt number, deadline, signal, and metadata.
- **Policy** — middleware-style unit that can observe, wrap, short-circuit, or retry downstream work.
- **Pipeline** — deterministic policy ordering and onion-style execution.
- **Adapters** — package-level wrappers that turn transport APIs into Resili operations.
- **Plugins** — setup-time extension points for policies, events, and service overrides.

## Development Status

Resili is under active development. The core framework, built-in policies, plugin runtime, public entry points, and minimal fetch/Axios/Undici adapters are implemented and tested in this repository.

Current package version placeholders are `0.0.0`; publishing and release automation are intentionally separate from the runtime implementation.

## Roadmap

Near-term work is focused on hardening the implemented surface:

- API Extractor coverage for adapter packages.
- Package README files for individual adapters.
- Additional integration tests across policy combinations.
- Production examples for common Node.js service patterns.
- Optional ecosystem packages for metrics exporters and distributed state stores.

Deferred items include OpenTelemetry exporters, Prometheus exporters, dashboards, additional transport adapters, and release automation.

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

## License

MIT © Nitin Kaushal and contributors.
