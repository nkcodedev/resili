# Versioning and dist-tags

## Install

**Default install:** Beta 1 on `latest` / `beta`. Published RC1 is on `next`. RC2 is prepared in
this repository and is not yet published.

```bash
npm install @resili/core
npm install @resili/llm @resili/llm-openai
```

`latest` and `beta` currently both point at Beta 1. `next` currently points at RC1. RC2
(`0.2.0-rc.2` / `0.1.0-rc.2`) is prepared and not on the registry. Historical alpha builds remain
available as `@alpha` / exact `*-alpha.*` versions. See [RC2 status](./rc2-status.md) and
[RC1 status](./rc1-status.md).

```bash
# Published release candidate (npm next today)
npm install @resili/core@0.2.0-rc.1
npm install @resili/core@next

# RC2 exact pins (prepared; not published yet)
npm install @resili/core@0.2.0-rc.2
npm install @resili/llm@0.1.0-rc.2
```

Neither Beta, RC1, nor RC2 is a stable `1.0` guarantee — pin exact versions in production.

## Current dist-tags (public registry)

Current tags:

| Package                 | `latest` / `beta` | `alpha` (historical) | `next` (published RC1) | In-repo (RC2, not published) |
| ----------------------- | ----------------- | -------------------- | ---------------------- | ---------------------------- |
| `@resili/core`          | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1`           | `0.2.0-rc.2`                 |
| `@resili/fetch`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1`           | `0.2.0-rc.2`                 |
| `@resili/axios`         | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1`           | `0.2.0-rc.2`                 |
| `@resili/undici`        | `0.2.0-beta.1`    | `0.2.0-alpha.3`      | `0.2.0-rc.1`           | `0.2.0-rc.2`                 |
| `@resili/llm`           | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1`           | `0.1.0-rc.2`                 |
| `@resili/llm-openai`    | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1`           | `0.1.0-rc.2`                 |
| `@resili/llm-anthropic` | `0.1.0-beta.1`    | `0.1.0-alpha.4`      | `0.1.0-rc.1`           | `0.1.0-rc.2`                 |
| `@resili/llm-gemini`    | `0.1.0-beta.1`    | `0.1.0-alpha.3`      | `0.1.0-rc.1`           | `0.1.0-rc.2`                 |

Verify at any time:

```bash
npm view @resili/core dist-tags
```

### Dist-tag notes

- After Beta 1 publish, `latest` was moved to Beta 1 so `npm install @resili/core` installs the
  current public release.
- The `beta` tag also points at Beta 1 (same versions today).
- The `alpha` tag remains frozen on the final alpha line for historical installs.
- RC1 was published with `--tag next` only. RC2, when published, uses `--tag next` only. Do **not** move `latest` or `beta` for an RC cut.
- Stable `1.0` is a later bar.

If you are unsure what you actually installed:

```bash
npm ls @resili/core @resili/llm
```

## Two version lines

| Line        | Packages                                                      | In-repo (RC2) | `next` (RC1) | `latest` / `beta` |
| ----------- | ------------------------------------------------------------- | ------------- | ------------ | ----------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`                 | `0.2.0-rc.2`  | `0.2.0-rc.1` | `0.2.0-beta.1`    |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic`, `-llm-gemini` | `0.1.0-rc.2`  | `0.1.0-rc.1` | `0.1.0-beta.1`    |

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
    "@resili/core": "0.2.0-rc.2",
    "@resili/llm": "0.1.0-rc.2",
    "@resili/llm-openai": "0.1.0-rc.2"
  }
}
```

Those RC2 pins match this repository and are not on npm yet. A range like `^0.2.0-rc.2` behaves
unintuitively with prereleases. Exact versions avoid the
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
