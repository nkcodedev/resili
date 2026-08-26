# Versioning and dist-tags

## Install from the `beta` tag

```bash
npm install @resili/core@beta
npm install @resili/llm@beta @resili/llm-openai@beta
```

The `@beta` suffix is **required** for the current recommended prerelease. Installing without a tag
gives you `latest`, which still points at `0.1.0-alpha.1`, an early build that predates streaming,
several policies, and the current error model.

Historical alpha builds remain available as `@alpha` / exact `*-alpha.*` versions.

## Current dist-tags (after Beta.1 publish)

| Package                 | `beta` (current) | `alpha` (final) | `latest` (stale) |
| ----------------------- | ---------------- | --------------- | ---------------- |
| `@resili/core`          | `0.2.0-beta.1`   | `0.2.0-alpha.3` | `0.1.0-alpha.1`  |
| `@resili/fetch`         | `0.2.0-beta.1`   | `0.2.0-alpha.3` | `0.1.0-alpha.1`  |
| `@resili/axios`         | `0.2.0-beta.1`   | `0.2.0-alpha.3` | `0.1.0-alpha.1`  |
| `@resili/undici`        | `0.2.0-beta.1`   | `0.2.0-alpha.3` | `0.1.0-alpha.1`  |
| `@resili/llm`           | `0.1.0-beta.1`   | `0.1.0-alpha.4` | `0.1.0-alpha.1`  |
| `@resili/llm-openai`    | `0.1.0-beta.1`   | `0.1.0-alpha.4` | `0.1.0-alpha.1`  |
| `@resili/llm-anthropic` | `0.1.0-beta.1`   | `0.1.0-alpha.4` | `0.1.0-alpha.1`  |
| `@resili/llm-gemini`    | `0.1.0-beta.1`   | `0.1.0-alpha.3` | `0.1.0-alpha.1`  |

Until the Beta.1 npm publish completes, `beta` may be absent on the registry; workspace and packed
tarballs already use the Beta.1 versions. Verify at any time:

```bash
npm view @resili/core dist-tags
```

### Why `latest` is behind

`0.1.0-alpha.1` was published before the `alpha` tag convention was adopted, and npm assigned it
`latest` automatically. Every release since has used an explicit prerelease tag (`alpha`, then
`beta`), which does not move `latest`.

Leaving `latest` where it is, is deliberate. Moving it would make `npm install @resili/core` — the
command people type without thinking — resolve to a prerelease, implying a stability guarantee that
Beta does not yet carry. `latest` will move when the first stable release is published.

Practical consequences while this holds:

- `npm install @resili/core` installs `0.1.0-alpha.1`. Always add `@beta` (or pin an exact version).
- `npm outdated` compares against `latest` and will look wrong.
- Renovate and Dependabot follow `latest` by default; configure them for the `beta` tag or pin exact
  versions.

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

`latest` is not moved for Beta. Coordinated Git tag: `beta.1`. See
[`BETA_RELEASE_PLAN.md`](./BETA_RELEASE_PLAN.md).
