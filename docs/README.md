# Resili documentation

A TypeScript-first resilience toolkit for Node.js applications, HTTP clients, and LLM providers.

All packages are currently published on the npm `alpha` dist-tag. Install with `@alpha` — `latest`
still points at an early build. See [Versioning](./releases/versioning.md).

| Line        | Packages                                        | Current         |
| ----------- | ----------------------------------------------- | --------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`     | `0.2.0-alpha.3` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`    | `0.1.0-alpha.4` |
|             | `@resili/llm-gemini`                             | `0.1.0-alpha.3` |

## Start here

New to Resili? [Installation](./getting-started/installation.md) →
[Quick start](./getting-started/quick-start.md) → [Concepts](./getting-started/concepts.md).

Then go to the layer you need: [Core](#core), [HTTP](#http), or [LLM](#llm).

## Getting started

- [Installation](./getting-started/installation.md) — packages, versions, peer dependencies
- [Quick start](./getting-started/quick-start.md) — first working example for core, HTTP, and LLM
- [Concepts](./getting-started/concepts.md) — operation, client, policy, pipeline, context

## Core

`@resili/core` wraps any async function with resilience policies. Zero runtime dependencies.

- [Overview](./core/overview.md) — client entry points, configuration, extension points
- [Policies](./core/policies.md) — all nine at a glance
- [Policy ordering](./core/policy-ordering.md) — default pipeline order and why it matters
- [Execution context](./core/execution-context.md) — identifiers, metadata, fork semantics
- [Cancellation](./core/cancellation.md) — `AbortSignal` end to end

### Individual policies

| Policy                                          | Protects against                       |
| ----------------------------------------------- | -------------------------------------- |
| [Retry](./core/retry.md)                         | Transient failures                      |
| [Timeout](./core/timeout.md)                     | Slow or hung calls                       |
| [Circuit breaker](./core/circuit-breaker.md)     | Hammering a failing dependency            |
| [Rate limiter](./core/rate-limiter.md)           | Exceeding a quota                         |
| [Bulkhead](./core/bulkhead.md)                   | Unbounded concurrency                      |
| [Cache](./core/cache.md)                         | Repeated identical work                     |
| [Fallback](./core/fallback.md)                   | Total failure reaching the caller            |
| [Dedupe](./core/dedupe.md)                       | Duplicate concurrent identical calls          |
| [Hedge](./core/hedge.md)                         | Tail latency                                   |

## HTTP

- [Overview](./http/overview.md) — what the adapters share, and what they deliberately do not do
- [`@resili/fetch`](./http/fetch.md)
- [`@resili/axios`](./http/axios.md)
- [`@resili/undici`](./http/undici.md)

Two things to read before your first request: HTTP status codes are
[not classified as failures by default](./http/overview.md#status-codes-are-not-classified-by-default),
and adapters
[compose the caller `AbortSignal` into Resili execution](./http/overview.md#cancellation-and-caller-abortsignal).

## LLM

`@resili/llm` plus a provider adapter. Provider SDK retries are disabled so Resili owns resilience.

- [Overview](./llm/overview.md) — architecture, `createLlmClient()`, design principles
- [generate()](./llm/generate.md) — unary calls
- [Streaming](./llm/streaming.md) — pull-through streaming and the commit point
- [Retries](./llm/retries.md) · [Timeouts](./llm/timeouts.md) · [Cancellation](./llm/cancellation.md)
- [Budget Guard](./llm/budget-guard.md) — cost limits with estimated reservation and settlement
- [Pricing](./llm/pricing.md) · [Usage](./llm/usage.md) — micro-USD cost and normalized tokens
- [Errors](./llm/errors.md) — classifications and retryability

If you read only one LLM page, read
[the commit point](./llm/streaming.md#the-commit-point). It determines when a stream can and cannot be
retried, and it is the behavior that changed in `0.1.0-alpha.4`.

## Providers

- [OpenAI](./providers/openai.md) — Chat Completions; Responses API deferred
- [Anthropic](./providers/anthropic.md) — Messages API, partial usage merging
- [Gemini](./providers/gemini.md) — `@google/genai`, cumulative snapshot de-duplication

## Observability

- [Events](./observability/events.md) — high-cardinality lifecycle hooks for tracing and logs
- [Metrics](./observability/metrics.md) — low-cardinality counters and histograms for dashboards
- [Telemetry and privacy](./observability/telemetry.md) — what is never in a payload, and why

## Architecture

- [Overview](./architecture/overview.md) — execution flow, contracts, design principles
- [Policy pipeline](./architecture/policy-pipeline.md) — how policies compose, writing your own
- [Error classification](./architecture/error-classification.md) — failure versus retryable
- [Package boundaries](./architecture/package-boundaries.md) — what lives where

Deeper specifications: [ARCHITECTURE.md](./ARCHITECTURE.md),
[API_SPECIFICATION.md](./API_SPECIFICATION.md), [INTERNAL_DESIGN.md](./INTERNAL_DESIGN.md).

## Reference

- [Packages](./reference/packages.md) — matrix of purpose, version, dependencies, status
- [Configuration](./reference/configuration.md) — every option, type, and default
- [Errors](./reference/errors.md) — every public error and its fields

## Release status

- [Alpha status](./releases/alpha-status.md) — what is implemented, what the known limitations are
- [Beta readiness](./releases/BETA_READINESS.md)
- [Core API freeze review](./releases/BETA_API_REVIEW.md)
- [LLM API freeze review](./releases/BETA_LLM_API_REVIEW.md)
- [HTTP API freeze review](./releases/BETA_HTTP_API_REVIEW.md)
- [Versioning](./releases/versioning.md) — dist-tags, version lines, pinning, upgrading
- [CHANGELOG](../CHANGELOG.md)

## Design notes

Records of specific design decisions, kept for context rather than as user guides:

- [Request deduplication](./design/request-deduplication.md)
- [Hedged requests](./design/hedged-requests.md)
- [In-memory cache](./design/memory-cache.md)

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) · [Commit guidelines](./COMMIT_GUIDELINES.md) ·
[Review checklist](./REVIEW_CHECKLIST.md) · [AI workflow](./AI_WORKFLOW.md)

Generated API documentation lives in `docs/api/` and is produced by `pnpm docs`.

## A note on accuracy

These pages describe the implementation as released, verified against source and tests. Planned work
is not documented as available; [Alpha status](./releases/alpha-status.md) is the single list of
current limitations and gaps.

If a page contradicts the code, the code is correct and the page is a bug worth reporting.
