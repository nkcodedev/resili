# Concepts

Resili has a small vocabulary. Everything else is built from these six ideas.

## The shape of a call

```text
Application
    ↓
Resili policies      (retry, timeout, circuit breaker, …)
    ↓
HTTP / LLM provider  (adapter)
    ↓
External service
```

Resili sits between your code and the thing that can fail. It does not replace your HTTP client or
your LLM SDK; it wraps the call to them.

## Operation

The unit of work — any `async` function. It can be an HTTP request, an SDK call, a database query, or
a queue publish. Resili is not HTTP-specific.

```ts
const operation = async (id: string) => fetch(`/users/${id}`);
```

## Client

An immutable wrapper around one operation plus a compiled policy pipeline. Build one with either
`createClient(operation, config)` or the fluent `resili(operation)…build()`. A client exposes:

| Member              | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `call(...args)`     | Runs the operation with the original argument types                |
| `execute(fn)`       | Runs a context-aware function through the same pipeline            |
| `on(type, handler)` | Subscribes to typed lifecycle [events](../observability/events.md) |
| `destroy()`         | Releases listeners and plugin resources; idempotent                |

Policy state (circuit breaker windows, cache entries, rate limiter buckets, bulkhead slots) lives on
the client, so create clients once and reuse them rather than per request.

## Policy

A middleware-style unit that wraps the next layer. A policy can observe, delay, short-circuit, retry,
time-box, or coordinate the work beneath it. Built-in policies:

[Retry](../core/retry.md) · [Timeout](../core/timeout.md) ·
[Circuit breaker](../core/circuit-breaker.md) · [Rate limiter](../core/rate-limiter.md) ·
[Bulkhead](../core/bulkhead.md) · [Cache](../core/cache.md) · [Fallback](../core/fallback.md) ·
[Dedupe](../core/dedupe.md) · [Hedge](../core/hedge.md)

## Pipeline

Policies compose as an onion in a deterministic order. The outermost policy sees the call first; the
operation is innermost.

```text
fallback → cache → retry → circuit-breaker → timeout → dedupe → hedge → rate-limiter → bulkhead → operation
```

Order is not cosmetic. Because retry is outside timeout, each retry attempt gets a fresh per-attempt
timer; because cache is outside retry, a cache hit skips retry entirely. See
[Policy ordering](../core/policy-ordering.md).

## Context

Immutable per-execution state threaded through every policy: `requestId`, `operationName`,
`serviceName`, `attemptNumber`, `metadata`, a composed `signal`, `deadline`, and `startedAt`.
Policies create children with `fork()` rather than mutating. See
[Execution context](../core/execution-context.md).

## Classifier

Resili does not hardcode "what counts as a failure". A `FailureClassifier` answers two questions —
is this outcome a failure, and is it retryable — and the retry and circuit breaker policies consult
it. The default `httpClassifier` understands HTTP status codes and Resili's own error types;
`@resili/llm` layers `llmClassifier` on top. See
[Error classification](../architecture/error-classification.md).

## Observability

Two separate surfaces, deliberately:

- **Events** are high-cardinality and carry `requestId`. Use them for tracing and debugging.
- **Metrics** are low-cardinality with a tiny label set. `requestId` is never a metric label.

Neither surface contains prompts, response bodies, generated text, or credentials. See
[Telemetry and privacy](../observability/telemetry.md).

## What Resili is not

- Not an HTTP client. Adapters wrap the client you already use.
- Not an AI SDK. `@resili/llm` has no prompts, agents, RAG, embeddings, or moderation.
- Not distributed. All policy state in this alpha is in-memory and process-local.
- Not a status-code interpreter by default. HTTP adapters return raw responses; classification is
  opt-in.

## Next steps

- [Core overview](../core/overview.md)
- [Alpha status](../releases/alpha-status.md) — what is and is not covered by this release
