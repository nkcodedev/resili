# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

## [Beta.1] - 2026-08-26

First public Beta cut. Published with `--tag beta`; `latest` now also resolves to Beta 1.

### Versions

| Family    | Packages                                                      | Version        |
| --------- | ------------------------------------------------------------- | -------------- |
| Core/HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-beta.1` |
| LLM       | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-beta.1` |

Gemini is intentionally aligned with the rest of the LLM family at `0.1.0-beta.1`.

### Core

- Public API honesty hardening for Beta freeze
- `RESILI_VERSION` reports the real `@resili/core` package version (ESM and CJS)
- `stats()` is totals-only; `health()` does not claim live circuit/bulkhead knowledge
- `timeout.deadlineMs` rejected; use context `deadline` / `deadlineMs` for overall bounds
- `RetryOptions.jitter` narrowed to `"none"`; `idempotentOnly` is not a public field
- `ResiliConfig.metrics` / `Builder.withMetrics` inject policy metrics
- `tsc` emit to `tsbuild/` so typecheck cannot overwrite the tsup `dist` bundle
- Cross-policy interaction coverage for critical pairs (retry×timeout, breaker, cache, dedupe, hedge, fallback)

### HTTP

- Caller `AbortSignal` support on fetch / axios / undici (composed into Core execution)
- Fetch / Axios / Undici public API freeze with API Extractor reports
- Additive `on()` / `destroy()` lifecycle without exposing full `Client`
- Packaging hardening: `tsbuild/` typecheck output, packed-consumer gates

### LLM

- `generate()`, pull-through `stream()`, and `result()`
- Streaming commit semantics: post-commit timeout does not start another generation
- Budget Guard, pricing, and usage accounting
- OpenAI Chat Completions, Anthropic Messages, Gemini `@google/genai` adapters
- Provider SDK retries disabled (`maxRetries: 0` / `attempts: 1`)

### Release engineering

- API Extractor coverage for all eight publishable packages
- Node 20 and Node 22 CI (Validate + packed consumer)
- `pnpm pack:check`: pack rewrite, workspace/file/link leak check, artifact safety, fresh ESM+CJS consumer
- Exactly one resolved `@resili/core` and `@resili/llm` in the packed consumer

### Install

Published with `--tag beta`. After publish, `latest` was also pointed at Beta 1, so plain installs
resolve to this cut:

```bash
npm install @resili/core
npm install @resili/llm @resili/llm-openai openai
```

### Known Beta limitations

- Beta APIs may still receive bug fixes; this is not a stable `1.0` guarantee
- Budget Guard and policy state are process-local (no distributed implementation)
- No TTFB or idle/chunk streaming timeouts
- No tools / function calling, multimodal, embeddings, or OpenAI Responses API in this cut
- HTTP status codes are not classified as failures by default
- `latest` and `beta` both resolve to Beta 1; historical `alpha` remains available under `@alpha`

### Documentation

- Beta status and release plan docs; install guides teach plain `npm install` for Beta 1
- Prior alpha hardening notes moved into this Beta.1 entry from Unreleased

## [LLM streaming timeout fix] - 2026-08-25

Corrective release for the streaming commit point. `@resili/core` remains `0.2.0-alpha.3`.

- `@resili/llm` `0.1.0-alpha.4`
- `@resili/llm-openai` `0.1.0-alpha.4`
- `@resili/llm-anthropic` `0.1.0-alpha.4`
- `@resili/llm-gemini` `0.1.0-alpha.3`

The provider adapters are republished with no adapter behavior change so their packed dependencies resolve to `@resili/llm@0.1.0-alpha.4`.

### Fixed

#### `@resili/llm`

- A logical stream is **committed** once the first non-empty user-visible `text-delta` has been delivered to the consumer. Metadata frames and empty text do not commit.
- After commit, a core per-attempt timeout can no longer start another provider generation. In `@resili/llm` `0.1.0-alpha.3` a `timeout.perAttemptMs` expiry after committed text was still classified retryable, so `retry.maxAttempts > 1` could run additional generations.
- Visible text in one logical stream now comes from exactly one provider generation. Duplicate text concatenated from multiple generations is prevented.
- Post-commit timeouts surface as `LlmError` with `classification: "timeout"` and `retryable: false` at the public stream boundary, including iteration, `result()`, and the `LlmStreamFailed` event (`committed: true`).
- Pre-commit retry behavior is unchanged: retryable provider failures and per-attempt timeouts before the first delivered non-empty text still retry according to the configured retry policy and classifier.
- Unary `generate()` retry, timeout, and `RetryExceededError` behavior is unchanged. Pre-commit timeout exhaustion on a stream also still surfaces `RetryExceededError`.

### Package Compatibility

- Republished `@resili/llm-openai`, `@resili/llm-anthropic`, and `@resili/llm-gemini` against `@resili/llm@0.1.0-alpha.4`.
- No provider adapter, `@resili/core`, or HTTP adapter runtime behavior changed in this release.

## [LLM streaming] - 2026-08-25

Independently versioned LLM packages. `@resili/core` remains `0.2.0-alpha.3`.

- `@resili/llm` `0.1.0-alpha.3`
- `@resili/llm-openai` `0.1.0-alpha.3`
- `@resili/llm-anthropic` `0.1.0-alpha.3`
- `@resili/llm-gemini` `0.1.0-alpha.2`

> **Published with a known defect.** These versions were released to npm. In `@resili/llm` `0.1.0-alpha.3` the retry commit point below was not enforced for core per-attempt timeouts, so a timeout after committed text could start another provider generation. Fixed in `@resili/llm` `0.1.0-alpha.4`.

### Added

#### `@resili/llm` `0.1.0-alpha.3`

- Provider-neutral pull-through streaming: `LlmClient.stream()` returns `LlmStream` (`text-delta` / `completed`, plus `result()`).
- Optional `LlmProvider.stream`. Missing `stream` fails only when `LlmClient.stream()` is called.
- Core `execute()` stays pending for the full consumer lifetime (complete, fail, abort, timeout, or early `return()` / `break`).
- Lazy start: `result()` does not start the provider. Iteration (or `next()`) starts pull-through. Unused `result()` is not an unhandled rejection.
- Consumer pull wait is the backpressure mechanism; `timeout.perAttemptMs` covers the complete attempt, including that wait (not TTFB or idle timeout).
- Retry only before the first non-empty `text-delta` is successfully delivered. After that commit point, stream failures are not automatically retried.
- Stream lifecycle events `LlmStreamStarted`, `LlmStreamCompleted`, and `LlmStreamFailed` (no prompt, completion, or chunk payloads).
- Stream metrics (`streams`, failures, duration, TTFT, chunks, output tokens) with `result` labels only.
- Budget Guard remains the same process-local preflight inside the wrapping `execute()`. Interrupted streams may omit authoritative billed usage; Resili does not invent token counts.

#### `@resili/llm-openai` `0.1.0-alpha.3`

- Chat Completions streaming via `stream: true` on the raw iterable (not an accumulator helper).
- `stream_options.include_usage: true`.
- SDK `maxRetries: 0` so Resili owns retries.
- Resili `AbortSignal` passed into the SDK request.
- First `choices[0]` only.
- Mid-stream SDK errors use the same `LlmError` mapping as unary `generate()`.

#### `@resili/llm-anthropic` `0.1.0-alpha.3`

- Messages streaming via `stream: true` on the raw event iterable (not `messages.stream()` helpers).
- SDK `maxRetries: 0`.
- Resili `AbortSignal` passed into the SDK request.
- Partial usage merged across frames; missing counts are not estimated.
- Mid-stream SDK errors use the same `LlmError` mapping as unary `generate()`.

#### `@resili/llm-gemini` `0.1.0-alpha.2`

- `models.generateContentStream` with `config.abortSignal`.
- SDK HTTP retry suppression (`httpOptions.retryOptions.attempts: 1`).
- Stream usage mapping that does not zero earlier counts when a later frame omits them.
- Official `@google/genai` samples append chunk text (deltas). Chunks whose text starts with the previous chunk snapshot emit only the new suffix so overlapping prefixes are not duplicated.
- Mid-stream SDK errors use the same `LlmError` mapping as unary `generate()`.

### Known alpha limitations

- Text input and text output only. This streaming release does not add tools or multimodal APIs.
- No TTFB timeout and no idle timeout. `timeout.perAttemptMs` is the complete attempt, including consumer pull wait.
- Budget Guard remains process-local (not distributed).
- Interrupted streams can lack authoritative billed usage.
- OpenAI streaming reads `choices[0]` only. Gemini streaming uses the first candidate.

## Previously released LLM packages

These notes document versions that already shipped. They are not new in the streaming release. `@resili/llm`, `@resili/llm-openai`, and `@resili/llm-anthropic` `0.1.0-alpha.2` were compatibility republishes against `@resili/core@0.2.0-alpha.3` (see `[0.2.0-alpha.3]`).

#### `@resili/llm` `0.1.0-alpha.1`

- Provider-neutral LLM foundation for Resili (`createLlmClient`, `defineProvider`).
- Provider-neutral contracts: `LlmRequest`, `LlmResponse`, `LlmUsage`, and `LlmError` classification/retryability.
- Usage and cost accounting from an injectable price table (integer micro-USD).
- Budget Guard with estimated-cost preflight, process-local reservations, and unknown-pricing reject/allow behavior.
- Typed LLM lifecycle events and low-cardinality metrics (`result` only).

#### `@resili/llm-openai` `0.1.0-alpha.1`

- OpenAI Chat Completions adapter for `@resili/llm` using a user-owned OpenAI client.
- Normalized usage and OpenAI/HTTP error mapping to `LlmError`.
- SDK retry suppression (`maxRetries: 0` on every Chat Completions call) so Resili owns retries.
- AbortSignal integration from Resili timeout/cancellation into the SDK request.

#### `@resili/llm-anthropic` `0.1.0-alpha.1`

- Anthropic Messages adapter for `@resili/llm` using a user-owned Anthropic client.
- Normalized usage and Anthropic/HTTP error mapping to `LlmError`.
- SDK retry suppression (`maxRetries: 0` on every Messages call) so Resili owns retries.
- AbortSignal integration from Resili timeout/cancellation into the SDK request.
- Required caller-supplied `maxTokens` (Anthropic requires `max_tokens`; no silent default).

#### `@resili/llm-gemini` `0.1.0-alpha.1`

- Google Gemini `models.generateContent` adapter for `@resili/llm` using a user-owned `@google/genai` client.
- Normalized usage and Gemini/HTTP error mapping to `LlmError`.
- SDK HTTP retry suppression (`httpOptions.retryOptions.attempts: 1`) so Resili owns retries.
- AbortSignal integration via `config.abortSignal`.
- Unary text-in / text-out only at this version (no streaming, tools, multimodal, or Vertex setup). Streaming is added in `@resili/llm-gemini` `0.1.0-alpha.2`.

## [0.2.0-alpha.3] - 2026-08-25

Core hardening for `@resili/core`. HTTP adapters are republished at the same version so packed `workspace:*` dependencies resolve to `@resili/core@0.2.0-alpha.3`. Adapter runtime behavior is unchanged.

### Improved

#### `@resili/core`

- `"cache"` is a valid built-in relative policy-order anchor (`before` / `after`); resolved order is `149.5` / `150.5` around canonical cache `150`.
- `RequestStarted` and `RequestCompleted` are emitted once per top-level `call()` / `execute()` (not per retry). `RequestCompleted` uses `status: "success" | "error"`; `errorCode` is set only for Resili errors.
- `stats().totals.retries` counts extra attempts after the first (`RetryStarted`). `stats().circuit`, `stats().bulkhead`, and `stats().rateLimiter` remain empty; `health()` is derived from those maps and is not live built-in policy aggregation.
- Rate limiter `onLimit: "wait"` with required `maxWaitMs` waits for capacity (FIFO per key, `AbortSignal` / timeout abort while waiting, no busy loop) and rejects immediately when the next wait would exceed the remaining budget.

### Package Compatibility

- Republished `@resili/fetch`, `@resili/axios`, and `@resili/undici` as `0.2.0-alpha.3` against `@resili/core@0.2.0-alpha.3`.
- Republished `@resili/llm`, `@resili/llm-openai`, and `@resili/llm-anthropic` as `0.1.0-alpha.2` so they resolve against `@resili/core@0.2.0-alpha.3`.
- No LLM provider or runtime behavior changed in this compatibility release.

## [0.2.0-alpha.2] - 2026-08-01

This release completes the v0.2 Intelligent Request Management scope.

### Added

- Hedged Requests, Request Deduplication, and Memory Cache as first-class policies.
- Typed lifecycle events and low-cardinality metrics for the v0.2 request-management policies.
- Reproducible local benchmark framework for baseline overhead, Memory Cache, Request Deduplication, Hedged Requests, and combined Cache + Dedupe scenarios.
- Updated README and contributing guide for the expanded v0.2 runtime.

### Improved

- Policy ordering and integration coverage across built-in policies.
- Cancellation, cleanup, and concurrency hardening for request-management policies.
- CI validation for the benchmark workspace.
- Package metadata, package contents, and API validation for release preparation.

## [0.2.0-alpha.1] - 2026-08-01

### Added

#### Core Runtime

- Fluent Builder API
- Declarative Client API
- Context propagation
- Deterministic policy pipeline
- Plugin runtime
- Typed events
- Metrics contracts

#### Built-in Policies

- Retry
- Timeout
- Circuit Breaker
- Bulkhead
- Rate Limiter
- Fallback

#### Intelligent Request Management

- Hedged Requests
- Request Deduplication
- Memory Cache

#### Adapters

- Fetch
- Axios-compatible
- Undici-compatible

### Documentation

- Comprehensive project README
- Architecture documentation
- API specification
- Internal design documentation
- Design documents for:
  - Hedged Requests
  - Request Deduplication
  - Memory Cache

### Infrastructure

- GitHub Actions CI
- API Extractor validation
- Branch protection rules
- Workspace validation for:
  - Formatting
  - Linting
  - Type checking
  - Testing
  - Builds
  - API compatibility

### Quality

- 429 automated tests passing
