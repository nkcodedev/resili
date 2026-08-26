# Beta status

**Stage: Beta.** Eight packages are published publicly. Beta 1 is the current release.

| Line        | Packages                                                      | Version        |
| ----------- | ------------------------------------------------------------- | -------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-beta.1` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-beta.1` |

`latest` and `beta` currently both resolve to Beta 1. Historical `alpha` builds remain available.
See [Versioning](./versioning.md).

```bash
npm install @resili/core
npm install @resili/llm @resili/llm-openai openai
```

## What Beta means

- Public contracts have been intentionally reviewed (Core, HTTP, LLM/providers).
- No known P0 correctness blockers remain for the shipping surface.
- Package and release gates are automated (`pnpm pack:check`, Node 20/22 CI, API Extractor).
- External developers can evaluate and integrate with pinned exact versions.
- APIs are expected to be **substantially stable** for the remainder of Beta.

## What Beta does not mean

- A stable `1.0` guarantee
- That every future feature is implemented
- Distributed policy or Budget Guard state
- Complete provider feature parity (tools, multimodal, embeddings, Responses API)
- Production certification or an LTS window

Pin exact versions and read the [CHANGELOG](../../CHANGELOG.md) before upgrading. Behavioral fixes may still ship in Beta without a type-level signal.

## Suitable for

- Evaluation and integration testing
- Early production paths where you can absorb a rare justified Beta fix
- Internal services that pin exact versions and follow the freeze records

## Known limitations

Summarized from [Alpha status](./alpha-status.md) (still accurate for product limits):

- Streaming: no separate TTFB or idle/chunk timeout; `perAttemptMs` covers the whole attempt including consumer pull time
- Core: policy state and Budget Guard are process-local; `retry.jitter` is `"none"` only; `timeout.deadlineMs` is rejected
- HTTP: status codes are not failures by default; injected client retries are not disabled
- LLM: text-in / text-out only; no tools, multimodal, or embeddings in this cut

## Freeze records

- [Core API freeze](./BETA_API_REVIEW.md)
- [HTTP API freeze](./BETA_HTTP_API_REVIEW.md)
- [LLM API freeze](./BETA_LLM_API_REVIEW.md)
- [Beta readiness](./BETA_READINESS.md)
