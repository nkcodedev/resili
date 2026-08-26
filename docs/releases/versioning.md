# Versioning and dist-tags

## Install

Beta 1 is the current public release. Plain installs resolve to Beta 1:

```bash
npm install @resili/core
npm install @resili/llm @resili/llm-openai
```

`latest` and `beta` currently both point at Beta 1. Historical alpha builds remain available as
`@alpha` / exact `*-alpha.*` versions. Beta is **not** a stable `1.0` guarantee — pin exact versions
in production.

## Current dist-tags

| Package                 | `latest` / `beta` | `alpha` (historical) |
| ----------------------- | ----------------- | -------------------- |
| `@resili/core`          | `0.2.0-beta.1`    | `0.2.0-alpha.3`      |
| `@resili/fetch`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      |
| `@resili/axios`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      |
| `@resili/undici`        | `0.2.0-beta.1`    | `0.2.0-alpha.3`      |
| `@resili/llm`           | `0.1.0-beta.1`    | `0.1.0-alpha.4`      |
| `@resili/llm-openai`    | `0.1.0-beta.1`    | `0.1.0-alpha.4`      |
| `@resili/llm-anthropic` | `0.1.0-beta.1`    | `0.1.0-alpha.4`      |
| `@resili/llm-gemini`    | `0.1.0-beta.1`    | `0.1.0-alpha.3`      |

Verify at any time:

```bash
npm view @resili/core dist-tags
```

### Dist-tag notes

- After Beta 1 publish, `latest` was moved to Beta 1 so `npm install @resili/core` installs the
  current public release.
- The `beta` tag also points at Beta 1 (same versions today).
- The `alpha` tag remains frozen on the final alpha line for historical installs.
- Stable `1.0` is a later bar; Beta may still receive justified bug fixes.

If you are unsure what you actually installed:

```bash
npm ls @resili/core @resili/llm
```

## Two version lines

| Line        | Packages                                                      | Current        |
| ----------- | ------------------------------------------------------------- | -------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-beta.1` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-beta.1` |

Versions are independent, so a fix in one layer does not force a release of the other. Packages within
a line are released together and their internal dependency ranges are pinned to the version published
in the same run. Mixing versions from different runs within one line is not supported.

## Version scheme

`MAJOR.MINOR.PATCH-beta.N`, with the beta counter incrementing per release within a line.

While the major version is `0`, semver's stability guarantees do not apply: a minor bump may contain a
breaking change. Read the [CHANGELOG](../../CHANGELOG.md) before upgrading, and pin exact versions in
anything you care about.

## Pinning

For reproducibility, pin exact versions rather than relying on a tag:

```json
{
  "dependencies": {
    "@resili/core": "0.2.0-beta.1",
    "@resili/llm": "0.1.0-beta.1",
    "@resili/llm-openai": "0.1.0-beta.1"
  }
}
```

A range like `^0.2.0-beta.1` behaves unintuitively with prereleases. Exact versions avoid the
question. Commit your lockfile.

## Upgrading

1. Read the [CHANGELOG](../../CHANGELOG.md) for both lines.
2. Upgrade all packages in a line together.
3. Check [Beta status](./beta-status.md) for known limitations.
4. Re-run your own integration tests. Behavior around retry, timeout, and streaming semantics has
   changed between alphas, and type-checking alone will not catch it.

## Provider SDK versions

LLM adapters declare their SDK as an optional peer dependency and never construct a client, so you
control the SDK version:

| Adapter                 | Peer range                   |
| ----------------------- | ---------------------------- |
| `@resili/llm-openai`    | `openai >=4.0.0`             |
| `@resili/llm-anthropic` | `@anthropic-ai/sdk >=0.20.0` |
| `@resili/llm-gemini`    | `@google/genai >=1.0.0`      |

`@resili/llm-gemini` targets `@google/genai`, **not** the legacy `@google/generative-ai`. The two have
different client shapes and are not interchangeable. → [Gemini](../providers/gemini.md)

`@resili/axios` and `@resili/undici` declare no peer dependency at all — they type those APIs
structurally and take an injected implementation, so any version works.

## Node

All packages require **Node 20 or newer** and ship both ESM and CommonJS builds with declarations for
each. CI validates Node 20 and Node 22.

## Release process

Releases are cut from `main` after lint, typecheck, the full test suite, build, API Extractor for all
eight packages, and `pnpm pack:check` all pass, then verified against the public registry in a clean
consumer project before the work is considered done.

Coordinated Git tag for the first beta cut: `beta.1`. See [`BETA_RELEASE_PLAN.md`](./BETA_RELEASE_PLAN.md)
(historical plan) and [`beta-status.md`](./beta-status.md).
