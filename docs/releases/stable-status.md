# Stable status

**Stage: First stable cut prepared (`0.2.0` / `0.1.0`).** Package versions and documentation in this
repository describe the stable release. The versions are **not published** until the approved npm
publish sequence completes and `latest` is promoted.

| Line        | Packages                                                      | Stable version |
| ----------- | ------------------------------------------------------------- | -------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0`        |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0`        |

## What this stable cut contains

Everything in published RC2, plus:

- Gemini HTTP `499` with the message `Client Closed Request` is caller cancellation
  (`AbortError` / `ERR_ABORTED`) and does not open the circuit breaker. An unrelated `499` stays
  `LlmError` / `ERR_LLM_UNKNOWN` and can open the circuit.
- Gemini, OpenAI, and Anthropic abort paths use a sanitized snapshot for `AbortError.cause` and
  `AbortError.reason`. A caller `AbortError` is preserved.

## What this does not mean (until publication finishes)

- That `npm install @resili/core` already resolves to `0.2.0` on the public registry
- That `latest` or `beta` has already moved
- That a GitHub release or git tag for `0.2.0` / `0.1.0` already exists

## Install (after publication)

```bash
npm install @resili/core
npm install @resili/core@0.2.0 @resili/fetch@0.2.0
npm install @resili/llm@0.1.0 @resili/llm-openai@0.1.0 openai
```

Budget Guard remains estimated-cost enforcement before a provider call. It is not a hard ceiling on
actual vendor billing.
