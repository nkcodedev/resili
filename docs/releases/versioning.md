# Versioning and dist-tags

## Install from the `alpha` tag

```bash
npm install @resili/core@alpha
npm install @resili/llm@alpha @resili/llm-openai@alpha
```

The `@alpha` suffix is **required**. Installing without it gives you `0.1.0-alpha.1`, an early build
that predates streaming, several policies, and the current error model.

## Current dist-tags

| Package                 | `alpha` (current) | `latest` (stale) |
| ----------------------- | ----------------- | ---------------- |
| `@resili/core`          | `0.2.0-alpha.3`   | `0.1.0-alpha.1`  |
| `@resili/fetch`         | `0.2.0-alpha.3`   | `0.1.0-alpha.1`  |
| `@resili/axios`         | `0.2.0-alpha.3`   | `0.1.0-alpha.1`  |
| `@resili/undici`        | `0.2.0-alpha.3`   | `0.1.0-alpha.1`  |
| `@resili/llm`           | `0.1.0-alpha.4`   | `0.1.0-alpha.1`  |
| `@resili/llm-openai`    | `0.1.0-alpha.4`   | `0.1.0-alpha.1`  |
| `@resili/llm-anthropic` | `0.1.0-alpha.4`   | `0.1.0-alpha.1`  |
| `@resili/llm-gemini`    | `0.1.0-alpha.3`   | `0.1.0-alpha.1`  |

Verify at any time:

```bash
npm view @resili/core dist-tags
```

### Why `latest` is behind

`0.1.0-alpha.1` was published before the `alpha` tag convention was adopted, and npm assigned it
`latest` automatically. Every release since has used `--tag alpha`, which does not move `latest`.

Leaving `latest` where it is, is deliberate. Moving it would make `npm install @resili/core` — the
command people type without thinking — resolve to a prerelease, implying a stability guarantee that an
alpha does not carry. `latest` will move when the first stable release is published.

Practical consequences while this holds:

- `npm install @resili/core` installs `0.1.0-alpha.1`. Always add `@alpha`.
- `npm outdated` compares against `latest` and will look wrong.
- Renovate and Dependabot follow `latest` by default; configure them for the `alpha` tag or pin exact
  versions.

If you are unsure what you actually installed:

```bash
npm ls @resili/core @resili/llm
```

## Two version lines

| Line        | Packages                                       | Current         |
| ----------- | ---------------------------------------------- | --------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`  | `0.2.0-alpha.3` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic` | `0.1.0-alpha.4` |
|             | `@resili/llm-gemini`                           | `0.1.0-alpha.3` |

Versions are independent, so a fix in one layer does not force a release of the other. The
`0.1.0-alpha.4` LLM release shipped against the existing `@resili/core@0.2.0-alpha.3` with no core
change at all.

Packages within a line are released together and their internal dependency ranges are pinned to the
version published in the same run. Mixing versions from different runs within one line is not
supported.

`@resili/llm-gemini` at `alpha.3` is not an oversight. The `alpha.4` corrective release republished
the packages whose packed dependency range needed to resolve to `@resili/llm@0.1.0-alpha.4`; Gemini's
own increment landed at `alpha.3` and is the current release for that package.

## Version scheme

`MAJOR.MINOR.PATCH-alpha.N`, with the alpha counter incrementing per release within a line.

While the major version is `0`, semver's stability guarantees do not apply: a minor bump may contain a
breaking change. Read the [CHANGELOG](../../CHANGELOG.md) before upgrading, and pin exact versions in
anything you care about.

The `0.1 → 0.2` bump on the core line reflected accumulated additive and breaking change during alpha,
not a stability milestone.

## Pinning

For reproducibility, pin exact versions rather than relying on a tag:

```json
{
  "dependencies": {
    "@resili/core": "0.2.0-alpha.3",
    "@resili/llm": "0.1.0-alpha.4",
    "@resili/llm-openai": "0.1.0-alpha.4"
  }
}
```

A range like `^0.2.0-alpha.3` behaves unintuitively with prereleases — npm will not cross to
`0.2.0-alpha.4` under some resolvers, and will cross to `0.2.0` under others. Exact versions avoid the
question. Commit your lockfile.

## Upgrading

1. Read the [CHANGELOG](../../CHANGELOG.md) for both lines.
2. Upgrade all packages in a line together.
3. Check the [Alpha status](./alpha-status.md) page for changed limitations.
4. Re-run your own integration tests. Behavior around retry, timeout, and streaming semantics has
   changed between alphas, and type-checking alone will not catch it.

The `0.1.0-alpha.3 → alpha.4` LLM upgrade is a good illustration: no API changed, but a post-commit
streaming timeout stopped triggering a retry. Purely behavioral, and only visible if you test it.

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
each.

## Release process

Releases are cut from `main` after lint, typecheck, the full test suite, build, and the
`@resili/core` API report check all pass, then verified against the public registry in a clean
consumer project before the work is considered done.

`latest` is not moved. Git tags are created for release commits.

## Planned Beta channel (not published yet)

First beta cut decisions live in [`BETA_RELEASE_PLAN.md`](./BETA_RELEASE_PLAN.md). Summary:

| Family    | Planned versions                                     | Install once published          |
| --------- | ---------------------------------------------------- | ------------------------------- |
| Core/HTTP | `0.2.0-beta.1`                                       | `npm install @resili/core@beta` |
| LLM       | `0.1.0-beta.1` (all four adapters, including Gemini) | `npm install @resili/llm@beta`  |

- Publish with `--tag beta`.
- Leave `latest` unchanged until stable `1.x`.
- Leave `alpha` at the final alpha builds for historical installs.

Until that cut ships, continue using `@alpha` or exact alpha versions.
