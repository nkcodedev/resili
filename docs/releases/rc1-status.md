# First stable RC1 status

**Stage: Release candidate (exact versions).** Eight RC1 packages remain on the public registry at
`0.2.0-rc.1` / `0.1.0-rc.1`. npm `next` now points at [RC2](./rc2-status.md). `latest` and `beta`
still serve Beta 1. Independent consumer testing is a **NO-GO** for promoting RC1 to `latest`; see
[RC1 release-blocker review](../RC1_RELEASE_BLOCKER_REVIEW.md).

| Line        | Packages                                                      | RC1 (exact)  | `latest` / `beta` |
| ----------- | ------------------------------------------------------------- | ------------ | ----------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-rc.1` | `0.2.0-beta.1`    |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-rc.1` | `0.1.0-beta.1`    |

See [Versioning](./versioning.md). Historical Beta guidance remains in [Beta status](./beta-status.md).

## What RC1 means

- Candidate cut toward the first non-beta (`0.2.0` / `0.1.0`) stable path.
- Includes OpenAI cancellation normalization (`ERR_ABORTED`) and HTTP status-retry safety
  (status-based retries require explicit `retryOn` / custom classifier).
- Same release gates as Beta: lint, typecheck, tests, build, API Extractor, `pnpm pack:check`,
  Node 20/22 CI.
- npm dist-tag: **`next`**. Do **not** move `latest` or `beta` for RC1.

## What RC1 does not mean

- A stable `1.0` / LTS guarantee
- That `npm install @resili/core` (unpinned) installs RC1
- Distributed policy or Budget Guard state
- Complete provider feature parity (tools, multimodal, embeddings, Responses API)

## Install

```bash
npm install @resili/core@0.2.0-rc.1
npm install @resili/llm@0.1.0-rc.1 @resili/llm-openai@0.1.0-rc.1 openai
# or the next dist-tag:
npm install @resili/core@next
```

## Beta 1 → RC1 migration

### HTTP status retries (behavioral change)

`httpClassifier.isRetryable` no longer treats resolved responses with HTTP `.status`
(`408` / `429` / `5xx`) as automatically retryable. Opt in with `retry.retryOn` or a custom
classifier. Prefer that only for operations that are safe to replay.

`httpClassifier.isFailure` is unchanged: Circuit Breaker still counts selected `.status` values
(`408`, `500`, `502`, `503`, `504`) as failures. Thrown timeout / abort / network classification is
unchanged. Undici’s `statusCode` field remains unrecognized by the default classifier.

Timeout and other thrown retries can still repeat non-idempotent work. This cut does **not** claim
full HTTP idempotency guarantees.

### LLM cancellation

Caller cancellation through `@resili/llm-openai` normalizes to Core `AbortError` / `ERR_ABORTED`
(including openai@7 `APIUserAbortError` with `.name === "Error"`). Already-aborted requests do not
invoke the provider; in-flight cancellation is non-retryable; streaming does not restart after
commitment.

## Known limitations

Same product limits as Beta (see [Beta status](./beta-status.md) and [Alpha status](./alpha-status.md)):

- Streaming: no separate TTFB or idle/chunk timeout
- Core: process-local policy / Budget Guard state; `retry.jitter` is `"none"` only
- HTTP: undici `statusCode` not seen by default; injected client retries are not disabled
- LLM: text-in / text-out only; no tools, multimodal, or embeddings in this cut

## Draft GitHub prerelease notes (unpublished)

**Title:** Resili first stable RC1 (`0.2.0-rc.1` · `0.1.0-rc.1`)

**Prerelease:** yes

**Body (draft):**

```markdown
First release candidate toward the non-beta stable path.

### Versions

- Core/HTTP: `0.2.0-rc.1`
- LLM: `0.1.0-rc.1`

### Highlights

- OpenAI cancellation → Core `AbortError` / `ERR_ABORTED`
- HTTP status retries require explicit opt-in (`retryOn` / custom classifier)
- Circuit Breaker `.status` failure classification unchanged
- Packed-consumer + API Extractor gates green on Node 20/22

### Install

npm install @resili/core@0.2.0-rc.1
npm install @resili/llm@0.1.0-rc.1

Published with `--tag next`. `latest` / `beta` remain on Beta 1.

### Migration

If you relied on default retry of resolved `503`/`429`/etc., add explicit `retryOn`.
See CHANGELOG [RC.1].
```

Do **not** create the GitHub Release or Git tags from this document alone.

## Publish record

RC1 was published with `--tag next`. Do not republish these versions. Dependency order:

1. `@resili/core@0.2.0-rc.1`
2. `@resili/fetch@0.2.0-rc.1`
3. `@resili/axios@0.2.0-rc.1`
4. `@resili/undici@0.2.0-rc.1`
5. `@resili/llm@0.1.0-rc.1`
6. `@resili/llm-openai@0.1.0-rc.1`
7. `@resili/llm-anthropic@0.1.0-rc.1`
8. `@resili/llm-gemini@0.1.0-rc.1`

Do not change `latest` or `beta`. Verify with `npm view <pkg> dist-tags` and a clean consumer install
from the public registry.

## Freeze records

- [Core API freeze](./BETA_API_REVIEW.md)
- [HTTP API freeze](./BETA_HTTP_API_REVIEW.md)
- [LLM API freeze](./BETA_LLM_API_REVIEW.md)
- [Beta readiness](./BETA_READINESS.md) (historical publish record for Beta 1)
