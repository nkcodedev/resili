# Package boundaries

Resili is eight packages on two independent version lines. This page explains what belongs where and
why.

## Dependency graph

```text
                        @resili/core          (zero runtime dependencies)
                              │
        ┌─────────────┬───────┴───────┬─────────────────┐
        │             │               │                 │
  @resili/fetch  @resili/axios  @resili/undici     @resili/llm
                                                        │
                                    ┌───────────────────┼───────────────────┐
                                    │                   │                   │
                          @resili/llm-openai  @resili/llm-anthropic  @resili/llm-gemini
                                    │                   │                   │
                              openai (peer)   @anthropic-ai/sdk (peer)  @google/genai (peer)
```

Dependencies flow one way. Nothing depends on a sibling, and nothing depends upward.

## Layers

| Layer         | Packages                                           | Knows about                                |
| ------------- | -------------------------------------------------- | ------------------------------------------ |
| **Core**      | `@resili/core`                                     | Async functions. Nothing else.             |
| **Transport** | `@resili/fetch`, `@resili/axios`, `@resili/undici` | Core + one HTTP call shape                 |
| **Domain**    | `@resili/llm`                                      | Core + LLM concepts (tokens, cost, budget) |
| **Provider**  | `@resili/llm-openai`, `-anthropic`, `-gemini`      | Core + `@resili/llm` + one vendor SDK      |

## Why core has zero dependencies

`@resili/core` is meant to be safe to adopt anywhere: a Lambda where cold-start size matters, a
library that cannot impose transitive dependencies on its consumers, an environment with a strict
supply-chain review. Every dependency added to core is a dependency imposed on every user of every
Resili package.

It also enforces the design. Core cannot special-case HTTP because it cannot see HTTP — no `Response`,
no status codes, no headers. That constraint is what keeps "wrap any async operation" true rather than
aspirational.

## What belongs in core

**Yes:** policy contracts and built-in policies, the pipeline, context, classification, the error
hierarchy, the event bus, the metrics contract, plugin runtime, `Clock`, `StateStore`.

**No:** anything that needs a dependency, transport-specific behavior, vendor SDK knowledge, telemetry
exporters, or distributed state clients. Those go in adapter or plugin packages.

## Structural typing in HTTP adapters

`@resili/axios` and `@resili/undici` do not import — or declare a peer dependency on — `axios` or
`undici`. They describe the call shape with local interfaces and take an injected implementation.

The result: you control the version, you control the instance and its configuration, and there is no
version-range conflict between your app and Resili. The cost is that the adapters use structural
types rather than the real library types, and they cannot implement library-specific features like
interceptors or dispatchers.

Because nothing is imported, nothing is disabled either. An injected client with its own retry
mechanism will retry inside each Resili attempt — see
[HTTP adapters](../http/overview.md#not-feature-parity).

## Optional peers in LLM adapters

LLM adapters declare their SDK as an **optional peer dependency**:

| Adapter                 | Peer                | Range      |
| ----------------------- | ------------------- | ---------- |
| `@resili/llm-openai`    | `openai`            | `>=4.0.0`  |
| `@resili/llm-anthropic` | `@anthropic-ai/sdk` | `>=0.20.0` |
| `@resili/llm-gemini`    | `@google/genai`     | `>=1.0.0`  |

Optional, so installing an adapter does not pull down an SDK you may not use; a peer, so version
expectations are documented and mismatches produce a warning rather than a silent duplicate install.

The client is always **caller-owned**. Resili never constructs an SDK client and never reads an API
key or environment variable, which keeps credentials in your code and keeps SDK configuration —
`baseURL`, custom `fetch`, Vertex settings — entirely yours.

Adapters are separate packages, one per vendor, so an OpenAI user carries no Anthropic or Gemini code,
and a vendor's breaking SDK change affects only its own adapter.

## Why `@resili/llm` is separate from core

LLM concepts — tokens, model identity, cost, budget, finish reasons, nine extra event types — are
domain-specific and would be dead weight in core for HTTP-only users.

Keeping them separate also let streaming ship without touching core. The
[commit point](../llm/streaming.md#the-commit-point) is enforced entirely within `@resili/llm`, using
two existing core mechanisms: metadata values shared across forks, and a wrapped classifier. No new
core policy, no core API change, and no change to unary behavior.

The one thing this split costs is that core's event map is **closed** — which is exactly why
`@resili/llm` has its own event bus, surfaced as `on` alongside core's `onCore`.

## Two version lines

| Line        | Packages                                       | Current         |
| ----------- | ---------------------------------------------- | --------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`  | `0.2.0-alpha.3` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic` | `0.1.0-alpha.4` |
|             | `@resili/llm-gemini`                           | `0.1.0-alpha.3` |

Versions are independent, so a fix in one layer does not force a release of the other. The
`0.1.0-alpha.4` LLM release did not require a new core version.

`@resili/llm-gemini` sitting one patch behind is normal: the alpha.4 corrective release republished
the packages whose packed dependency range needed to resolve to `@resili/llm@0.1.0-alpha.4`, and
Gemini's own increment landed at `alpha.3`. It is the current release for that package.

See [Package reference](../reference/packages.md) and [Versioning](../releases/versioning.md).

## Adding a package

The test for a new package:

1. Does it need a runtime dependency? Then not core.
2. Does it know a specific transport or vendor? Then not core, and not `@resili/llm`.
3. Does it introduce a version constraint on consumers? Then an optional peer, injected.
4. Can it be built on the public API alone? If not, the public API is missing something.

## Import discipline

- Everything is imported from a package root (`@resili/core`, `@resili/llm`). There are no deep
  subpath imports.
- Each package's public surface is its `index.ts`. `@resili/core`'s is additionally tracked by an
  API Extractor report (`packages/core/etc/core.api.md`), so an unintended surface change fails CI.
- Both ESM `import` and CommonJS `require()` are supported through conditional exports.

## Limitations

- Structural typing in HTTP adapters means no library-specific features.
- Core's event map cannot be extended.
- All policy state is in-memory; `StateStore` is the seam, but no distributed implementation ships yet.
- No plugin packages exist yet — no OpenTelemetry, Prometheus, or Redis integration.
- Two version lines mean checking compatibility across the boundary when upgrading.
