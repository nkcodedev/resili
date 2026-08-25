# Resili

> A TypeScript-first resilience toolkit for Node.js applications, HTTP clients, and LLM providers.

[![version](https://img.shields.io/badge/alpha-0.2.0--alpha.3-blue.svg)](docs/releases/versioning.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![typescript](https://img.shields.io/badge/types-TypeScript-blue.svg)](#)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](packages/core/package.json)
[![core dependencies](https://img.shields.io/badge/core%20dependencies-zero-brightgreen.svg)](packages/core/package.json)

Resili puts a layer of composable, typed reliability policies between your application and whatever it
depends on:

```text
Application
    ↓
Resili policies      retry · timeout · circuit breaker · rate limit · bulkhead · cache · fallback
    ↓
HTTP / LLM provider
    ↓
External service
```

The core idea is that a policy wraps an **async function** — not a request object, not a URL. So the
same nine policies protect a `fetch` call, an SDK call, a database query, a queue publish, or an LLM
generation. Configuration is declared once, validated at build time, and composed into a deterministic
pipeline.

```ts
import { resili } from "@resili/core";

const users = resili((id: string) => fetch(`https://api.example.com/users/${id}`))
  .timeout({ perAttemptMs: 1_000 })
  .retry({ maxAttempts: 3, backoff: "exponential", jitter: "none" })
  .circuitBreaker({ minimumThroughput: 10 })
  .build();

const response = await users.call("42");
```

**[Full documentation →](docs/README.md)**

## Status

Alpha. Published on the npm `alpha` dist-tag, with the full test suite, type-checking, API-report
verification, and public-registry consumer verification green.

Suitable for evaluation, integration testing, and early adoption where you can pin exact versions.
Not yet claiming API stability or semver guarantees. See
[Alpha status](docs/releases/alpha-status.md).

## Packages

### Core

| Package                         | Purpose                                                                                | Alpha version   | Status |
| ------------------------------- | -------------------------------------------------------------------------------------- | --------------- | ------ |
| [`@resili/core`](packages/core) | Runtime: context, pipeline, nine policies, events, metrics, errors. Zero dependencies. | `0.2.0-alpha.3` | Alpha  |

### HTTP

| Package                             | Purpose                                             | Alpha version   | Status |
| ----------------------------------- | --------------------------------------------------- | --------------- | ------ |
| [`@resili/fetch`](packages/fetch)   | fetch-compatible adapter                            | `0.2.0-alpha.3` | Alpha  |
| [`@resili/axios`](packages/axios)   | axios-compatible adapter (injected implementation)  | `0.2.0-alpha.3` | Alpha  |
| [`@resili/undici`](packages/undici) | undici-compatible adapter (injected implementation) | `0.2.0-alpha.3` | Alpha  |

### LLM

| Package                                           | Purpose                                                          | Alpha version   | Status |
| ------------------------------------------------- | ---------------------------------------------------------------- | --------------- | ------ |
| [`@resili/llm`](packages/llm)                     | Provider-neutral client, usage, pricing, Budget Guard, telemetry | `0.1.0-alpha.4` | Alpha  |
| [`@resili/llm-openai`](packages/llm-openai)       | OpenAI Chat Completions — unary + streaming                      | `0.1.0-alpha.4` | Alpha  |
| [`@resili/llm-anthropic`](packages/llm-anthropic) | Anthropic Messages — unary + streaming                           | `0.1.0-alpha.4` | Alpha  |
| [`@resili/llm-gemini`](packages/llm-gemini)       | Google Gemini (`@google/genai`) — unary + streaming              | `0.1.0-alpha.3` | Alpha  |

The two version lines move independently. `@resili/llm-gemini` at `alpha.3` is its current release —
see [Versioning](docs/releases/versioning.md).

## Installation

Install with the `@alpha` tag. `latest` still points at `0.1.0-alpha.1`, an early build that predates
streaming and several policies.

```bash
npm install @resili/core@alpha

# with an HTTP adapter
npm install @resili/core@alpha @resili/fetch@alpha

# with LLM support
npm install @resili/core@alpha @resili/llm@alpha @resili/llm-openai@alpha openai
```

Node 20 or newer. Every package ships ESM and CommonJS builds with TypeScript declarations.

Provider SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`) are optional peer dependencies — you
install and construct the client, so you control the version and the credentials.

## Quick start

### Core resilience

```ts
import { createClient } from "@resili/core";

const client = createClient(
  async (id: string) => {
    const response = await fetch(`https://api.example.com/users/${id}`);
    return (await response.json()) as { id: string; name: string };
  },
  {
    timeout: { perAttemptMs: 1_000 },
    retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 100, jitter: "none" },
    circuitBreaker: { minimumThroughput: 10, failureRateThreshold: 50 },
  },
);

const user = await client.call("42");
```

`failureRateThreshold` is a **percentage**, so `50` means half the calls in the window.

→ [Core docs](docs/core/overview.md) · [All policies](docs/core/policies.md)

### fetch

```ts
import { createFetch } from "@resili/fetch";

const fetchWithResilience = createFetch({
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await fetchWithResilience("https://api.example.com/users");
```

→ [fetch docs](docs/http/fetch.md)

### axios

The adapter takes your axios instance, so its configuration stays yours.

```ts
import axios from "axios";
import { createAxios } from "@resili/axios";

const client = createAxios({
  axios: axios.create({ baseURL: "https://api.example.com" }),
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 2, jitter: "none" },
});

const response = await client.get("/users");
```

→ [axios docs](docs/http/axios.md)

### undici

```ts
import { request } from "undici";
import { createUndici } from "@resili/undici";

const client = createUndici({
  request,
  timeout: { perAttemptMs: 2_000 },
  retry: { maxAttempts: 2, jitter: "none" },
});

const response = await client({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
});
```

→ [undici docs](docs/http/undici.md)

HTTP status codes are **not** treated as failures by default — a 503 is a returned value, not a thrown
error. Opt in with `retry.retryOn`. See
[HTTP overview](docs/http/overview.md#status-codes-are-not-classified-by-default).

### LLM `generate()`

```ts
import OpenAI from "openai";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const openai = new OpenAI();

const llm = createLlmClient({
  provider: createOpenAiProvider({ client: openai, model: "gpt-4.1-mini" }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 3, baseDelayMs: 500, jitter: "none" },
  // Prices are yours to supply — Resili hard-codes none. Example values only.
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 1,
      outputPerMillionTokensUsd: 5,
    },
  ]),
  budget: { maxCostPerRequestUsd: 0.05 },
});

const result = await llm.generate({
  input: "Explain backpressure in one sentence.",
  estimatedInputTokens: 20,
  estimatedOutputTokens: 60,
});

console.log(result.response.content, result.usage.totalTokens, result.cost?.totalCostUsd);
```

Provider SDK retries are disabled by the adapter so that Resili owns retry behavior.

→ [LLM overview](docs/llm/overview.md) · [generate()](docs/llm/generate.md)

### LLM `stream()`

```ts
const stream = llm.stream({
  input: "Write a haiku about backpressure.",
});

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }
}

const { usage, cost } = await stream.result();
```

Streaming is **pull-through**: provider chunks are pulled in response to consumer demand, and nothing
is executed until you start iterating. Once the first non-empty text delta reaches you, the stream is
_committed_ and Resili will not start another provider generation — which is what stops a retry from
concatenating two answers.

→ [Streaming](docs/llm/streaming.md) · [the commit point](docs/llm/streaming.md#the-commit-point)

## Policies

Nine policies, composed in a deterministic order:

| Policy                                          | Use it to                                 |
| ----------------------------------------------- | ----------------------------------------- |
| [Retry](docs/core/retry.md)                     | Recover from transient failures           |
| [Timeout](docs/core/timeout.md)                 | Bound one attempt                         |
| [Circuit breaker](docs/core/circuit-breaker.md) | Stop calling an unhealthy dependency      |
| [Rate limiter](docs/core/rate-limiter.md)       | Stay inside a quota                       |
| [Bulkhead](docs/core/bulkhead.md)               | Bound concurrency and queue depth         |
| [Cache](docs/core/cache.md)                     | Reuse recent successful results           |
| [Fallback](docs/core/fallback.md)               | Degrade instead of failing                |
| [Dedupe](docs/core/dedupe.md)                   | Share concurrent identical in-flight work |
| [Hedge](docs/core/hedge.md)                     | Cut tail latency                          |

```text
Fallback → Cache → Retry → Circuit Breaker → Timeout → Dedupe → Hedge → Rate Limiter → Bulkhead → Operation
```

A policy is installed only when you configure it. Order is configurable with relative anchors like
`{ before: "retry" }`, and it changes semantics — retry outside timeout means each attempt gets its own
budget. → [Policy ordering](docs/core/policy-ordering.md)

## Documentation

| Section                                                 | Contents                                               |
| ------------------------------------------------------- | ------------------------------------------------------ |
| [Getting started](docs/getting-started/installation.md) | Installation, quick start, concepts                    |
| [Core](docs/core/overview.md)                           | Every policy, ordering, context, cancellation          |
| [HTTP](docs/http/overview.md)                           | fetch, axios, undici adapters                          |
| [LLM](docs/llm/overview.md)                             | generate, streaming, budget, pricing, errors           |
| [Providers](docs/providers/openai.md)                   | OpenAI, Anthropic, Gemini specifics                    |
| [Observability](docs/observability/events.md)           | Events, metrics, telemetry and privacy                 |
| [Architecture](docs/architecture/overview.md)           | Pipeline internals, classification, package boundaries |
| [Reference](docs/reference/packages.md)                 | Packages, configuration, errors                        |
| [Release status](docs/releases/alpha-status.md)         | What is implemented, known limitations, versioning     |

Runnable examples live in [`examples/`](examples). Generated API documentation is in `docs/api/`
(`pnpm docs`).

## Design principles

- **Wrap any async operation**, not just HTTP. One abstraction across transports and SDKs.
- **Zero dependencies in core.** Transport and vendor code lives in adapter packages.
- **Fail loudly at build time.** Invalid configuration throws immediately, never silently degrades.
- **Injectable time.** Policies use a `Clock`, so retry and breaker behavior is deterministic in tests.
- **Native primitives.** Cancellation is `AbortSignal`, nothing proprietary.
- **Privacy by construction.** No outbound telemetry; events and metrics never carry prompts,
  generated text, keys, or `Authorization` headers.
- **Caller owns credentials.** Resili never constructs a provider client or reads an environment
  variable.

## Contributing

pnpm workspaces with TypeScript project references.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @resili/core api:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Architecture and API decisions are
recorded in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/API_SPECIFICATION.md](docs/API_SPECIFICATION.md), and
[docs/INTERNAL_DESIGN.md](docs/INTERNAL_DESIGN.md).

## Maintainer

Created and maintained by **Nitin Kaushal**.

- GitHub: https://github.com/nkcodedev
- Email: nkcodedev.chd@gmail.com

If you find the project useful, please consider starring the repository.

## License

MIT © Nitin Kaushal and contributors.
