# Architecture overview

This section describes how Resili is built. For the full implementation contract — including design
rationale, invariants, and decision records — see [`ARCHITECTURE.md`](../ARCHITECTURE.md),
[`API_SPECIFICATION.md`](../API_SPECIFICATION.md), and
[`INTERNAL_DESIGN.md`](../INTERNAL_DESIGN.md).

## Execution flow

```text
operation arguments
    ↓
Client.call(...args)  /  Client.execute(fn)
    ↓
Context creation                    requestId, deadline, composed signal, metadata
    ↓
Pipeline.execute(ctx)
    ↓
policies, in canonical order        fallback → cache → retry → circuit-breaker →
                                    timeout → dedupe → hedge → rate-limiter → bulkhead
    ↓
wrapped operation / adapter
    ↓
external dependency
```

## Runtime contracts

Seven abstractions, each with a single job.

| Contract       | Responsibility                                                                    |
| -------------- | --------------------------------------------------------------------------------- |
| **Client**     | Immutable wrapper around one operation and one compiled pipeline                  |
| **Context**    | Immutable per-execution state: identity, attempt, deadline, signal, metadata      |
| **Policy**     | Middleware that may observe, delay, short-circuit, retry, time-box, or coordinate |
| **Pipeline**   | Deterministic ordering and onion-style composition                                |
| **Classifier** | Decides what counts as a failure and what is retryable                            |
| **Events**     | Typed lifecycle notifications                                                     |
| **Metrics**    | Framework-neutral counters, gauges, histograms                                    |

Two more are injected for determinism: **Clock**, so every timing decision is controllable in tests,
and **StateStore**, so policy state has a seam for future distributed backends.

## Design principles

**Wrap any async operation.** Resili is not HTTP-specific. HTTP and LLM support are adapters over the
same primitive, which is why one mental model covers both.

**Deterministic composition.** Policy order is defined by explicit numeric anchors, not registration
order or configuration accident. The same config always produces the same pipeline. See
[Policy pipeline](policy-pipeline.md).

**Injectable time.** Nothing calls `Date.now()` or `setTimeout` directly. Retry delays, timeout
timers, breaker windows, limiter refills, and cache TTLs all go through a `Clock`, which makes
time-dependent behavior testable without sleeping.

**Immutable context.** Policies fork rather than mutate, so concurrent attempts cannot interfere.
Metadata _values_ are shared by reference — a deliberate exception documented in
[Execution context](../core/execution-context.md#metadata-values-are-shared-across-forks).

**Native primitives.** `AbortController` and `AbortSignal` for cancellation, `AsyncIterator` for
streaming, standard `Error` subclasses with `cause`. No proprietary cancellation tokens or stream
types.

**Fail loudly on misconfiguration.** The client config surface is closed: an unknown key throws a
`ConfigurationError` naming the field. Options are validated eagerly at build time, and options that
are accepted-but-unimplemented (`jitter: "full"`, `idempotentOnly`) throw rather than being silently
ignored.

**Privacy by construction.** Telemetry carries identifiers, timings, counts, and outcomes — never
prompts, completions, bodies, or credentials. See [Telemetry](../observability/telemetry.md).

**Small core, adapters outside.** Zero runtime dependencies in core. Transport and provider
integrations live in their own packages. See [Package boundaries](package-boundaries.md).

## Where behavior lives

| Concern                            | Owner                                     |
| ---------------------------------- | ----------------------------------------- |
| Policy composition and ordering    | `@resili/core` pipeline                   |
| What counts as failure / retryable | The classifier (pluggable)                |
| Time                               | The `Clock` (injectable)                  |
| Policy state                       | In-memory per client, behind `StateStore` |
| HTTP semantics                     | HTTP adapters and your classifier         |
| Vendor SDK translation             | LLM provider adapters                     |
| Cost and budget                    | `@resili/llm`                             |
| Retry ownership for LLM calls      | Resili — SDK retries are disabled         |
| Retry ownership for HTTP calls     | **Yours** — adapters disable nothing      |

That last pair is the asymmetry most worth knowing. LLM adapters explicitly disable SDK retries so
Resili is the single retry authority. HTTP adapters do not touch the client you inject, so if it has
its own retry mechanism you must disable it yourself. See
[HTTP adapters](../http/overview.md#not-feature-parity).

## Streaming architecture

LLM streaming is pull-through rather than buffered, which required one addition to the model: a
**commit point**, after which retrying would corrupt output by concatenating two generations.

Enforcement uses two existing mechanisms rather than new machinery — a mutable flag in context
metadata (whose values are shared across forks) and a classifier wrapper that returns
non-retryable once committed. No new policy, no core API change, no change to unary behavior.

See [Streaming](../llm/streaming.md#the-commit-point).

## Pages

- [Policy pipeline](policy-pipeline.md) — composition and ordering
- [Error classification](error-classification.md) — failure and retryability decisions
- [Package boundaries](package-boundaries.md) — what belongs where

## Reference specifications

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — architecture specification and implementation contract
- [`API_SPECIFICATION.md`](../API_SPECIFICATION.md) — public API surface
- [`INTERNAL_DESIGN.md`](../INTERNAL_DESIGN.md) — internal design detail
- [`design/`](../design/) — per-feature design documents for hedging, dedupe, and memory cache
