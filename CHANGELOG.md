# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Changed

- `@resili/core` public contract honesty: `timeout.deadlineMs` is rejected; `RetryOptions.jitter` is `"none"` only; `idempotentOnly` is not a public field; `stats()` is totals-only; `health()` no longer claims circuit/bulkhead knowledge; `RESILI_VERSION` is generated from `package.json` (tsup/Vitest) so packed ESM and CJS match; `ResiliConfig.metrics` / `Builder.withMetrics` inject policy metrics. Core `tsc` emit is `tsbuild/` so it does not overwrite the tsup `dist` bundle.
- `@resili/llm` `CreateLlmClientOptions` omits Core `metrics`; LLM `metrics` records `resili_llm_*` only. LLM and provider packages emit `tsc` to `tsbuild/` so typecheck cannot overwrite packed ESM.

### Documentation

- Consolidated `docs/` into a topic-based structure (`getting-started/`, `core/`, `http/`, `llm/`, `providers/`, `observability/`, `architecture/`, `reference/`, `releases/`) with `docs/README.md` as the navigation home.
- Retired the pre-implementation planning stubs `docs/01-project-overview.md` … `docs/10-release.md` and `docs/roadmap.md`, whose contents described an API and feature set that was never shipped. `docs/ARCHITECTURE.md` §16 now indexes the current structure.
- Rewrote the root `README.md` around the current package inventory, per-line alpha versions, and quick starts for core, fetch, axios, undici, `generate()`, and `stream()`.
- Documented every shipped core policy individually, including `dedupe` and `hedge`, which had no user-facing documentation.
- Added dedicated pages for the policy pipeline, execution context, cancellation, LLM streaming and its commit point, Budget Guard, pricing, usage, the error model, events, metrics, and telemetry/privacy.
- Corrected stale claims: `circuitBreaker.failureRateThreshold` is a percentage (`50`), not a fraction (`0.5`); the rate limiter implements both `reject` and `wait` modes, and `maxWaitMs` is required for one and rejected for the other; `@resili/core` config accepts `cache`, `dedupe`, and `hedge`; HTTP adapters replace the caller's request signal and expose no per-call options, so caller-initiated cancellation is not available through them; install commands need the `@alpha` dist-tag because `latest` still points at `0.1.0-alpha.1`.
- Added offline, credential-free examples for `core`, `fetch`, `axios`, and `undici`, plus an `examples/README.md` index. All `.env.example` files remain empty placeholders.

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
