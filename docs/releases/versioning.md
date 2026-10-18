# Versioning and dist-tags

## Install

**Published today:** Beta 1. Plain installs resolve to Beta 1:

```bash
npm install @resili/core
npm install @resili/llm @resili/llm-openai
```

`latest` and `beta` currently both point at Beta 1. Historical alpha builds remain available as
`@alpha` / exact `*-alpha.*` versions.

**Prepared in this repository:** first stable RC1 (`0.2.0-rc.1` / `0.1.0-rc.1`). RC1 is **not yet
published**. After publication, install exact RC versions or `@next`. See
[RC1 status](./rc1-status.md).

```bash
# After RC1 is published (intended tag: next)
npm install @resili/core@0.2.0-rc.1
npm install @resili/llm@0.1.0-rc.1
# or
npm install @resili/core@next
```

Neither Beta nor RC1 is a stable `1.0` guarantee — pin exact versions in production.

## Current dist-tags (public registry)

Until RC1 is published, tags remain:

| Package                 | `latest` / `beta` | `alpha` (historical) | `next` (RC1, after publish) |
| ----------------------- | ----------------- | -------------------- | --------------------------- |
| `@resili/core`          | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1` (planned)      |
| `@resili/fetch`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1` (planned)      |
| `@resili/axios`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1` (planned)      |
| `@resili/undici`        | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1` (planned)      |
| `@resili/llm`           | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1` (planned)      |
| `@resili/llm-openai`    | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1` (planned)      |
| `@resili/llm-anthropic` | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1` (planned)      |
| `@resili/llm-gemini`    | `0.1.0-beta.1`    | `0.1.0-alpha.3`      | `0.1.0-rc.1` (planned)      |

Verify at any time:

```bash
npm view @resili/core dist-tags
```

### Dist-tag notes

- After Beta 1 publish, `latest` was moved to Beta 1 so `npm install @resili/core` installs the
  current public release.
- The `beta` tag also points at Beta 1 (same versions today).
- The `alpha` tag remains frozen on the final alpha line for historical installs.
- RC1 should publish with `--tag next` only; do **not** move `latest` or `beta` for the RC cut.
- Stable `1.0` is a later bar.

If you are unsure what you actually installed:

```bash
npm ls @resili/core @resili/llm
```

## Two version lines

| Line        | Packages                                                      | In-repo (RC1) | Published      |
| ----------- | ------------------------------------------------------------- | ------------- | -------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-rc.1`  | `0.2.0-beta.1` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-rc.1`  | `0.1.0-beta.1` |

Versions are independent, so a fix in one layer does not force a release of the other. Packages within
a line are released together and their internal dependency ranges are pinned to the version published
in the same run. Mixing versions from different runs within one line is not supported.

## Version scheme

`MAJOR.MINOR.PATCH` with optional prerelease identifiers:

- `beta.N` — public beta
- `rc.N` — release candidate toward the corresponding non-prerelease

While the major version is `0`, semver's stability guarantees do not apply: a minor bump may contain a
breaking change. Read the [CHANGELOG](../../CHANGELOG.md) before upgrading, and pin exact versions in
anything you care about.

## Pinning

For reproducibility, pin exact versions rather than relying on a tag:

```json
{
  "dependencies": {
    "@resili/core": "0.2.0-rc.1",
    "@resili/llm": "0.1.0-rc.1",
    "@resili/llm-openai": "0.1.0-rc.1"
  }
}
```

A range like `^0.2.0-rc.1` behaves unintuitively with prereleases. Exact versions avoid the
question. Commit your lockfile.

## Upgrading

1. Read the [CHANGELOG](../../CHANGELOG.md) for both lines.
2. Upgrade all packages in a line together.
3. Check [RC1 status](./rc1-status.md) (or [Beta status](./beta-status.md) if still on Beta) for
   known limitations and migration notes — especially HTTP status-retry opt-in.
4. Re-run your own integration tests. Behavior around retry, timeout, and streaming semantics has
   changed between alphas/beta/RC, and type-checking alone will not catch it.

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
(historical plan) and [`beta-status.md`](./beta-status.md). RC1 draft notes and publish order:
[`rc1-status.md`](./rc1-status.md).
