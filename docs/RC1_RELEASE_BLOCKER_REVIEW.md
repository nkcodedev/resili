# RC1 release-blocker review

Independent consumer run on Node.js 20 and 22: 135 tests, 111 passed, 17 failed, 7 skipped.
ESM, CommonJS, strict TypeScript, and cross-package integration passed. Stable release: **NO-GO**.

This review covers the source repository only. Published `0.2.0-rc.1` / `0.1.0-rc.1` artifacts
were not modified. Package versions were not bumped. Nothing was published, tagged, or pushed.

## 1. Issue A — Retry backoff cancellation

**Verdict:** Confirmed bug.

**Root cause:** `executeWithRetry` slept with `services.clock.setTimeout` and did not observe the
caller `AbortSignal`. Aborting during a delay left the timer running, and the next attempt started
when the delay elapsed.

**Affected package:** `@resili/core` (`packages/core/src/policies/retry/index.ts`).

**Code changes:** Backoff now listens to the root caller signal, clears the timer, and removes the
abort listener. An already-aborted signal does not start an attempt. Abort during the delay rejects
with Core `AbortError` (`ERR_ABORTED`) and does not call the operation again. Per-attempt timeout
still uses a child signal, so a timeout remains retryable.

**Regression tests:** `packages/core/src/policies/retry/index.test.ts`

- already-aborted signal (DOMException reason) does not invoke the operation
- abort during a 400ms fixed delay, driven by `FakeClock`, stays at one attempt and clears the timer

**Compatibility:** Callers who aborted during backoff and still observed a later attempt will now
see `AbortError` instead. Timeout retry behavior is unchanged.

## 2. Issue B — Cancellation classification

**Verdict:** Confirmed bug at the public boundary, with one consumer expectation that does not
match the contract.

**Root cause:** Several adapters rethrew `signal.reason` when it was already an `Error`, so a
native `DOMException` named `AbortError` leaked. Axios `CanceledError` / `ERR_CANCELED` was an
ordinary `Error`, so `httpClassifier.isFailure` counted it and the circuit breaker could open.
The rate limiter returned that same DOMException. Anthropic rethrew `APIUserAbortError` and missed
the openai@7 shape where `.name === "Error"` and `constructor.name === "APIUserAbortError"`.
Gemini treated every `name === "DOMException"` and every numeric `status === 499` as cancellation,
then rethrew the original object.

OpenAI already normalized to Core `AbortError` and was the template.

**Affected packages:**

- `@resili/core` — classifier and rate limiter
- `@resili/fetch`, `@resili/axios`, `@resili/undici`
- `@resili/llm` — client and stream normalization
- `@resili/llm-anthropic`, `@resili/llm-gemini`

**Code changes:**

- Fetch, Axios, Undici, and the rate limiter wrap caller cancellation as Core `AbortError` /
  `ERR_ABORTED`. The original error is `cause` and `reason`.
- The default classifier treats `AbortError`, `name === "AbortError"`, `name === "CanceledError"`,
  and codes `ERR_ABORTED`, `ERR_CANCELED`, and `ABORT_ERR` as non-failures and non-retryable.
- Anthropic maps `APIUserAbortError`, including constructor-name-only errors, to `AbortError`.
- Gemini maps cancellation only when the error name is `AbortError`, the Google status/code is
  `CANCELLED` or `CANCELED`, or status is `499` **and** the message matches abort/cancel.

**Not a bug — bare HTTP 499:** A thrown error whose only signal is `status: 499` stays an unknown
failure. It can count toward the circuit breaker. It is not automatically retryable, which is the
same rule as any other unknown error. Successful HTTP responses are still not retried by status.
Do not treat every HTTP 499 as user cancellation: 499 is also used for other client-closed and
proxy conditions that are real dependency failures.

**Regression tests:**

- classifier: Axios cancel is terminal; status-only 499 remains a failure
- pipeline: cancel does not open the breaker; a genuine `Error` still does; abort during retry
  backoff does not add an extra breaker sample
- fetch / undici: `DOMException` becomes `AbortError` with that exception as `cause`, and a second
  call still reaches the implementation
- axios: `ERR_CANCELED` becomes `AbortError` and does not open the breaker
- rate limiter wait-mode abort rejects with `AbortError` / `ERR_ABORTED` and clears the timer
- anthropic: constructor-name `APIUserAbortError` becomes `AbortError`
- gemini: `AbortError` and `CANCELLED` normalize; bare status 499 stays `LlmError`

**Compatibility:** Code that used `instanceof DOMException`, axios `code === "ERR_CANCELED"`, or
Gemini object identity at the Resili boundary now sees `AbortError` / `ERR_ABORTED`. The original
value remains on `cause`. Timeouts and ordinary 5xx / network errors still count as failures.
No public exports were added. API Extractor reports are unchanged.

## 3. Issue C — Configuration validation

**Verdict:** Confirmed bug.

**Root cause:** Factories dereferenced `options.axios`, `options.request`,
`options.client.chat.completions.create`, `options.client.messages.create`,
`options.client.models.generateContent`, or `options.provider.execute` before checking that the
nested value existed. Missing, null, or partial objects threw `TypeError`.

**Affected packages:** `@resili/axios`, `@resili/undici`, `@resili/llm`, `@resili/llm-openai`,
`@resili/llm-anthropic`, `@resili/llm-gemini`.

`@resili/fetch` defaults `fetch` to `globalThis.fetch`, so a missing implementation is not a
required-client error. That behavior was left as-is.

**Code changes:** Each factory validates the object and the required function path first and throws
`ConfigurationError`.

**Regression tests:** missing, `null`, array (HTTP adapters), empty object, and partial nests for
Axios, Undici, the LLM client, and the three providers.

**Compatibility:** Those calls now throw `ConfigurationError` instead of `TypeError`. Valid
configurations are unchanged.

## 4. Issue D — Documentation and packaging

**Verdict:** Confirmed defects in source. Published npm tarballs were not edited.

**Axios README:** Four examples imported `"/axios"`. They now import `"@resili/axios"`.

**Publication statements:** README, package READMEs, installation, package reference, RC1 status,
and versioning now say RC1 is on npm `next` and that `latest` / `beta` remain Beta 1. They do not
say RC1 is the default install.

**Duplicate `//# sourceMappingURL=`:** Present on both `dist/index.js` and `dist/index.cjs` in all
eight packages. tsup `sourcemap: true` plus `outExtension` remapping `.js` to `.cjs` made esbuild
and tsup each append the comment. `scripts/dedupe-sourcemap-comments.mjs` runs from each package
`tsup.config.ts` `onSuccess` and keeps one comment. After `pnpm -r build`, all 16 bundles have
exactly one comment. Runtime behavior is unchanged.

**README links:** `pnpm docs:links` reported 0 errors and 0 warnings.

## 5. Regression tests

New or tightened coverage lives next to the existing suites. Tests use `FakeClock` or already-settled
rejections. The retry-backoff case does not wait 400ms.

| Area | Test |
| --- | --- |
| Already-aborted signal | retry policy; existing fetch/axios/undici cancellation suites still pass and now receive Core `AbortError` |
| Cancellation during backoff | retry policy; core pipeline with circuit breaker |
| Cancellation during an active request | existing adapter cancellation tests |
| Circuit breaker after cancellation | core pipeline, fetch, axios, undici |
| Cancellation with retry enabled | core pipeline (`maxAttempts: 2` or `3`) |
| Provider-specific cancellation | anthropic `APIUserAbortError`; gemini `CANCELLED` / abort `AbortError` |
| Genuine failures still count | core pipeline opens on `Error("upstream")`; gemini bare status 499 stays `LlmError`; classifier keeps status-only 499 as a failure |
| Configuration | axios, undici, llm client, openai, anthropic, gemini |

## 6. Compatibility risks

- Observable error type at the Resili boundary changes from `DOMException`, axios
  `ERR_CANCELED`, Anthropic `APIUserAbortError`, and Gemini abort objects to Core `AbortError`.
  Original errors are preserved as `cause`.
- A bare HTTP 499 is intentionally still a failure. A consumer assertion that every 499 is
  cancellation should be updated, not the library.
- Invalid configuration throws `ConfigurationError`.
- No version bump, no new public export, no API-report diff.
- The packages already on npm `next` do **not** contain these fixes.

## 7. Commands and results

Run on this branch. Node.js 22.23.2 unless noted.

| Command | Result |
| --- | --- |
| `pnpm format` | pass |
| `pnpm lint` | pass (`eslint . --max-warnings=0`) |
| `pnpm test` (Node.js 22.23.2) | 45 files, 693 tests passed |
| `pnpm test` (Node.js 20.19.6) | 45 files, 693 tests passed |
| `pnpm -r typecheck` | pass |
| `pnpm -r build` | pass |
| `pnpm api:check` | pass; all eight API reports up to date |
| `pnpm pack:check` | pass; packed consumer ok; versions remain `0.2.0-rc.1` / `0.1.0-rc.1` |
| `pnpm docs:links` | 0 errors, 0 warnings |
| source-map comment count | 1 comment in each of the 16 `dist/index.js` / `index.cjs` files |

## 8. Remaining blockers

- RC1 on the `next` dist-tag is still the build that failed the independent consumer. These fixes
  are source-only until a new prerelease is published.
- The independent consumer project was not modified or re-run.
- `latest` and `beta` correctly remain Beta 1. Promoting RC1 to either tag is still a NO-GO.
- `https://resili.nkcode.dev/` is still HTTP 404. Package `homepage` stays on GitHub. That is not
  a code blocker for this branch.

## 9. Recommendation for RC2

Do not promote `0.2.0-rc.1` / `0.1.0-rc.1` to `latest` or stable.

After review, publish the fixes as a new release candidate (`0.2.0-rc.2` for core/HTTP and
`0.1.0-rc.2` for the LLM packages) with `--tag next` only. Leave `latest` and `beta` on Beta 1.
Re-run the independent consumer against that prerelease before any stable decision.

No publish, dist-tag move, tag, or merge is authorized by this review.
