# RC2 status

**Stage: Release candidate (published on `next`).** Eight RC2 packages are on the public registry
under `next`. `latest` and `beta` still serve Beta 1. RC1 remains installable at exact versions.
This is not a stable release.

| Line        | Packages                                                      | `next` (published RC2) | `latest` / `beta` |
| ----------- | ------------------------------------------------------------- | ---------------------- | ----------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-rc.2`           | `0.2.0-beta.1`    |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-rc.2`           | `0.1.0-beta.1`    |

See [Versioning](./versioning.md) and the [RC1 release-blocker review](../RC1_RELEASE_BLOCKER_REVIEW.md).

## What RC2 contains

- Retry backoff observes the caller `AbortSignal` and does not start another attempt after cancel.
- Fetch, Axios, Undici, the rate limiter, Anthropic, and Gemini normalize caller cancellation to
  Core `AbortError` / `ERR_ABORTED`, with the original error preserved as `cause`.
- Axios `ERR_CANCELED`, Anthropic `APIUserAbortError`, and Gemini `CANCELLED` do not count as
  dependency failures and do not open the circuit breaker. Genuine upstream failures still do.
- Gemini HTTP status `499` is cancellation only when the error is `CANCELLED`/`CANCELED` or the
  message is an abort/cancel. A bare status `499` stays a provider failure.
- Missing or partial Axios, Undici, LLM, OpenAI, Anthropic, and Gemini clients throw
  `ConfigurationError`.
- Axios README imports use `@resili/axios`. Builds emit one `//# sourceMappingURL=` comment.

## What RC2 does not mean

- A stable `1.0` / LTS guarantee
- That `npm install @resili/core` (no tag) installs RC2. That install still resolves to Beta 1
- That `latest` or `beta` moved

## Install

```bash
# Default install (Beta 1 on latest)
npm install @resili/core

# Published RC2 (npm next)
npm install @resili/core@next
npm install @resili/core@0.2.0-rc.2
npm install @resili/llm@0.1.0-rc.2 @resili/llm-openai@0.1.0-rc.2 openai
```

`latest` and `beta` remain Beta 1. `alpha` remains on the historical alpha versions. Do not treat
RC2 as a stable release. Re-run independent consumer tests on Node.js 20 and 22 before any `latest`
promotion.
