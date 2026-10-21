# Resili

TypeScript resilience policies for Node.js: wrap an async function, an HTTP client, or an LLM call with retry, timeout, circuit breaker, bulkhead, and rate limiting.

[![npm next](https://img.shields.io/npm/v/@resili/core/next?label=npm%20next)](https://www.npmjs.com/package/@resili/core)
[![npm latest](https://img.shields.io/npm/v/@resili/core?label=npm%20latest)](https://www.npmjs.com/package/@resili/core)
[![downloads](https://img.shields.io/npm/dm/@resili/core)](https://www.npmjs.com/package/@resili/core)
[![CI](https://github.com/nkcodedev/resili/actions/workflows/ci.yml/badge.svg)](https://github.com/nkcodedev/resili/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/nkcodedev/resili)](LICENSE)
[![node](https://img.shields.io/node/v/@resili/core)](https://www.npmjs.com/package/@resili/core)

`npm next` is RC2. `npm latest` is still Beta 1. Node.js 20 or newer.

## Why Resili?

Dependencies fail in a few repeatable ways: a request errors once and succeeds on the next try, a call never returns, a dependency is down and every retry makes it worse, too many calls run at once, or a client exceeds a quota. LLM providers add timeouts, rate limits, and spend that is hard to see until the invoice arrives.

Resili puts those controls in one typed pipeline around an async function. You opt in to each policy. Invalid options throw when the client is built. Core has no runtime dependencies. HTTP and LLM packages are separate, and you construct the vendor client yourself.

## Quick start

Install the published core package. This command installs Beta 1, which is the `latest` tag. Use `@next` or the exact RC2 version for the current release candidate.

```bash
npm install @resili/core@next
```

```ts
import { resili } from "@resili/core";

const users = resili((id: string) => fetch(`https://api.example.com/users/${id}`))
  .timeout({ perAttemptMs: 1_000 })
  .retry({ maxAttempts: 3, backoff: "exponential", jitter: "none" })
  .circuitBreaker({ minimumThroughput: 10, failureRateThreshold: 50 })
  .build();

const response = await users.call("42");
```

`failureRateThreshold` is a percentage. `50` means 50 percent of sampled calls, not `0.5`. Retry follows the classifier: a plain `Error` is not retried unless `retryOn` returns true. Network errors retry only when the call is marked idempotent.

A local version of this flow, with a mocked dependency, is in [`examples/core`](examples/core). A StackBlitz-style project that installs published `@resili/core@0.2.0-rc.2` is in [`examples/stackblitz`](examples/stackblitz).

## Which package to install

| You are calling               | Install                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Any async function            | `@resili/core`                                                                  |
| `fetch`                       | `@resili/core` and `@resili/fetch`                                              |
| Your axios instance           | `@resili/core` and `@resili/axios`                                              |
| Your undici `request`         | `@resili/core` and `@resili/undici`                                             |
| A provider-neutral LLM client | `@resili/core` and `@resili/llm`                                                |
| OpenAI Chat Completions       | those, plus `@resili/llm-openai` and `openai`                                   |
| Anthropic Messages            | `@resili/core`, `@resili/llm`, `@resili/llm-anthropic`, and `@anthropic-ai/sdk` |
| Gemini `generateContent`      | `@resili/core`, `@resili/llm`, `@resili/llm-gemini`, and `@google/genai`        |

There is no unscoped `resili` package. Install only the scoped packages you use. Within one version line, install the same release together: Core and HTTP share `0.2.0-rc.2` on `next`; the LLM packages share `0.1.0-rc.2` on `next`.

```bash
npm install @resili/core@0.2.0-rc.2 @resili/fetch@0.2.0-rc.2
npm install @resili/core@0.2.0-rc.2 @resili/llm@0.1.0-rc.2 @resili/llm-openai@0.1.0-rc.2 openai
```

## Features

| Capability       | Where it lives                                    |
| ---------------- | ------------------------------------------------- |
| Retry            | [`@resili/core`](packages/core)                   |
| Timeout          | [`@resili/core`](packages/core)                   |
| Circuit breaker  | [`@resili/core`](packages/core)                   |
| Bulkhead         | [`@resili/core`](packages/core)                   |
| Rate limiter     | [`@resili/core`](packages/core)                   |
| Cache            | [`@resili/core`](packages/core)                   |
| Fallback         | [`@resili/core`](packages/core)                   |
| In-flight dedupe | [`@resili/core`](packages/core)                   |
| Hedge            | [`@resili/core`](packages/core)                   |
| `fetch`          | [`@resili/fetch`](packages/fetch)                 |
| axios            | [`@resili/axios`](packages/axios)                 |
| undici           | [`@resili/undici`](packages/undici)               |
| LLM client       | [`@resili/llm`](packages/llm)                     |
| OpenAI           | [`@resili/llm-openai`](packages/llm-openai)       |
| Anthropic        | [`@resili/llm-anthropic`](packages/llm-anthropic) |
| Gemini           | [`@resili/llm-gemini`](packages/llm-gemini)       |

Policies run in this order when you enable them:

```text
Fallback → Cache → Retry → Circuit Breaker → Timeout → Dedupe → Hedge → Rate Limiter → Bulkhead → Operation
```

A policy is installed only when you configure it. Order can change with relative anchors, and that changes behavior: retry outside timeout gives each attempt its own time budget. See [Policy ordering](docs/core/policy-ordering.md).

HTTP status codes are not failures unless you opt in with `retry.retryOn`. A returned `503` is still a successful function result. See [HTTP overview](docs/http/overview.md#status-codes-are-not-classified-by-default).

## LLM resilience

`@resili/llm` is not an AI SDK. It does not read API keys or construct a vendor client. The adapters wrap a client you create:

| Provider  | Package                 | SDK peer            |
| --------- | ----------------------- | ------------------- |
| OpenAI    | `@resili/llm-openai`    | `openai`            |
| Anthropic | `@resili/llm-anthropic` | `@anthropic-ai/sdk` |
| Gemini    | `@resili/llm-gemini`    | `@google/genai`     |

The same core timeout, retry, and circuit breaker options apply to `generate()` and `stream()`. Adapters disable the SDK's own retries so Resili owns the retry loop. Streaming is pull-through: the provider call starts when you iterate, and the first non-empty text delta commits the stream so a later retry cannot append a second answer.

```ts
import OpenAI from "openai";
import { createLlmClient } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({ client: new OpenAI(), model: "gpt-4.1-mini" }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 3, baseDelayMs: 500, jitter: "none" },
});

const result = await llm.generate({ input: "Explain backpressure in one sentence." });
console.log(result.response.content);
```

→ [LLM overview](docs/llm/overview.md) · [OpenAI](docs/providers/openai.md) · [Anthropic](docs/providers/anthropic.md) · [Gemini](docs/providers/gemini.md)

## Budget Guard

Budget Guard is implemented on `createLlmClient({ budget })` in `@resili/llm`. It compares **estimated** input and output tokens with a price table you supply. Resili does not ship model prices.

`maxCostPerRequestUsd` is checked before the provider is called. It is not a hard ceiling on actual spend: real output can exceed the estimate, and that actual cost is recorded afterward. `maxAccumulatedCostUsd` limits recorded spend plus in-flight reservations for a scope. The default ledger is process-local memory.

A rejected call throws `LlmBudgetExceededError` and does not call the provider. Run the offline demonstration:

```bash
node examples/budget-guard/example.mjs
```

That script uses `defineProvider` and a price table. It does not use an API key. See [`examples/budget-guard`](examples/budget-guard).

## Comparison

Checked against upstream documentation on 2026-10-21: [cockatiel](https://github.com/connor4312/cockatiel), [opossum](https://github.com/nodeshift/opossum), and [p-retry](https://github.com/sindresorhus/p-retry). "Included" means that repository documents the capability in the package itself.

| Capability            | Resili                                 | cockatiel                  | opossum                       | p-retry                       |
| --------------------- | -------------------------------------- | -------------------------- | ----------------------------- | ----------------------------- |
| Retry                 | Included                               | Included                   | Not included                  | Included                      |
| Timeout               | Included policy                        | Included policy            | Option on the breaker         | Separate package, `p-timeout` |
| Circuit breaker       | Included                               | Included                   | Included                      | Not included                  |
| Bulkhead              | Included                               | Included                   | Not included                  | Not included                  |
| Rate limiting         | Included                               | Not included               | Not included                  | Not included                  |
| HTTP client adapters  | fetch, axios, and undici packages      | Not included               | Not included                  | Not included                  |
| LLM provider adapters | OpenAI, Anthropic, and Gemini packages | Not included               | Not included                  | Not included                  |
| Composability         | One pipeline on a client               | `wrap()` combines policies | One breaker around a function | Retry around one function     |

Cockatiel also documents fallback. Opossum documents a fallback function for the open state. Resili includes fallback, cache, in-flight dedupe, and hedge in `@resili/core`. Those extra policies are not a claim that the other libraries are incomplete for their own scope. p-retry is a retry function. Opossum is a circuit breaker. Cockatiel is a policy toolkit without Resili's HTTP or LLM packages.

## Documentation

|                                                      |                                                          |
| ---------------------------------------------------- | -------------------------------------------------------- |
| [Installation](docs/getting-started/installation.md) | Tags, exact versions, and package layout                 |
| [Examples](examples)                                 | Offline core, HTTP, Budget Guard, and StackBlitz samples |
| [API reference](docs/reference/packages.md)          | Packages, configuration, and errors                      |
| [Architecture](docs/ARCHITECTURE.md)                 | Pipeline and package boundaries                          |
| [Contributing](CONTRIBUTING.md)                      | Setup, checks, and pull requests                         |

Generated TypeDoc output is produced by `pnpm docs` into `docs/api/`.

## Release status

| Tag                 | What `npm install` resolves                               | Meaning                                 |
| ------------------- | --------------------------------------------------------- | --------------------------------------- |
| `latest` and `beta` | `@resili/core@0.2.0-beta.1`, LLM packages `@0.1.0-beta.1` | Default install. Not a stable release.  |
| `next`              | `@resili/core@0.2.0-rc.2`, LLM packages `@0.1.0-rc.2`     | Published RC2.                          |
| exact `rc.1`        | `0.2.0-rc.1` / `0.1.0-rc.1`                               | Previous candidate. Not the `next` tag. |
| `alpha`             | Final alpha on each line                                  | Historical.                             |

RC3 is planned and is not published. No stable `1.0` release has been approved. Do not point production at a tag if you need a reproducible install; pin exact versions.

Details: [RC2 status](docs/releases/rc2-status.md) · [Versioning](docs/releases/versioning.md)

## Contributing

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [Contributing guide](CONTRIBUTING.md)
- [Issues](https://github.com/nkcodedev/resili/issues)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

GitHub Discussions is not enabled on this repository.

## License

MIT © Nitin Kaushal and contributors.
