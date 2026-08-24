# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

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
