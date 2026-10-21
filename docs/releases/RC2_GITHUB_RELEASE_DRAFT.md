# Draft: GitHub release for published RC2

This file is a review draft. It does not create a GitHub release, a Git tag, or an npm publish.

## Proposed release

| Field                          | Value                                      |
| ------------------------------ | ------------------------------------------ |
| Title                          | Resili RC2 (`0.2.0-rc.2` / `0.1.0-rc.2`)   |
| Tag                            | `rc2`                                      |
| Target commit                  | `40205e477f5ba9236c5a6017ab773ad3fe152209` |
| Commit subject                 | `chore(release): prepare Resili RC2 (#42)` |
| Prerelease                     | yes                                        |
| npm dist-tag already published | `next`                                     |

Do not tag the current working tree. It contains unpublished Gemini cancellation and provider-error sanitization fixes that are not in the RC2 npm tarballs. Those belong in a later candidate.

The repository has no single package version. One Git tag covers both lines, matching the earlier `beta.1` tag:

- `@resili/core`, `@resili/fetch`, `@resili/axios`, `@resili/undici` at `0.2.0-rc.2`
- `@resili/llm`, `@resili/llm-openai`, `@resili/llm-anthropic`, `@resili/llm-gemini` at `0.1.0-rc.2`

`latest` and `beta` stay on Beta 1. This is not a stable release.

## Draft notes

Resili RC2 is published on npm under the `next` dist-tag.

```bash
npm install @resili/core@next
npm install @resili/core@0.2.0-rc.2 @resili/fetch@0.2.0-rc.2
npm install @resili/llm@0.1.0-rc.2 @resili/llm-openai@0.1.0-rc.2 openai
```

`npm install @resili/core` with no tag still installs Beta 1.

### Fixed in this candidate

- Caller abort during a retry delay no longer starts another attempt.
- Fetch, Axios, Undici, the rate limiter, Anthropic, and Gemini normalize caller cancellation to Core `AbortError` / `ERR_ABORTED`.
- Axios `ERR_CANCELED`, Anthropic `APIUserAbortError`, and Gemini `CANCELLED` do not count as dependency failures.
- A Gemini HTTP `499` without a cancel or abort signal stays a provider failure in this published candidate.
- Missing or partial Axios, Undici, LLM, OpenAI, Anthropic, and Gemini clients throw `ConfigurationError`.
- Package bundles emit one `//# sourceMappingURL=` comment.
- Axios README examples import `@resili/axios`.

### Not in this candidate

- Stable `1.0` or a move of `latest`.
- Gemini HTTP `499` with the message `Client Closed Request` treated as cancellation.
- Sanitized provider abort causes that omit raw SDK errors and API keys.

Those two items are unpublished work on `main` after `40205e4`.
