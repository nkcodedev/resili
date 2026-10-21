# RC2 status

**Stage: Release candidate (prepared in-repo, not published).** Eight packages are versioned for
RC2. They are **not yet published** to npm. The public registry still serves RC1 on `next` and
Beta 1 on `latest` / `beta`.

| Line        | Packages                                                      | In-repo (RC2) | `next` (published RC1) | `latest` / `beta` |
| ----------- | ------------------------------------------------------------- | ------------- | ---------------------- | ----------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-rc.2`  | `0.2.0-rc.1`           | `0.2.0-beta.1`    |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-rc.2`  | `0.1.0-rc.1`           | `0.1.0-beta.1`    |

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

- That these versions are already on the public registry
- A stable `1.0` / LTS guarantee
- That `npm install @resili/core` or `@resili/core@next` installs RC2
- That RC1 should be promoted to `latest`

## Install

Until publication, install RC2 only from a local pack of this repository. The registry commands
below are the intended pins after publication:

```bash
# Published today
npm install @resili/core@0.2.0-rc.1
npm install @resili/core@next

# After RC2 publication
npm install @resili/core@0.2.0-rc.2
npm install @resili/llm@0.1.0-rc.2 @resili/llm-openai@0.1.0-rc.2 openai
```

## Publish plan (not executed)

Publish in dependency order with `--tag next` only, after this preparation is reviewed:

1. `@resili/core@0.2.0-rc.2`
2. `@resili/fetch@0.2.0-rc.2`
3. `@resili/axios@0.2.0-rc.2`
4. `@resili/undici@0.2.0-rc.2`
5. `@resili/llm@0.1.0-rc.2`
6. `@resili/llm-openai@0.1.0-rc.2`
7. `@resili/llm-anthropic@0.1.0-rc.2`
8. `@resili/llm-gemini@0.1.0-rc.2`

Do not change `latest` or `beta`. Do not republish RC1. Verify with `npm view <pkg> dist-tags`
before each publish.
