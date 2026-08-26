# Installation

Resili is published as independently versioned packages. Install only what you use.

## Requirements

- Node.js **20 or newer** (every package declares `"engines": { "node": ">=20" }`)
- TypeScript is optional but supported; every package ships `.d.ts` and `.d.cts` declarations
- Both ESM `import` and CommonJS `require()` are supported through conditional exports

## Current release channel

The recommended prerelease channel is the npm `beta` dist-tag. The `latest` tag still points at older
`0.1.0-alpha.1`-era builds, so install with an explicit `@beta` (or an exact version). Plain
`npm install @resili/core` does **not** install Beta. See
[Versioning and dist-tags](../releases/versioning.md) and [Beta status](../releases/beta-status.md).

```bash
npm install @resili/core@beta
```

Historical alpha builds remain available under `@alpha` for comparison installs.

## Core

`@resili/core` has **zero runtime dependencies** and is the only required package.

```bash
npm install @resili/core@beta
```

## HTTP adapters

Each adapter depends only on `@resili/core`. None of them bundles or requires the underlying HTTP
library — `@resili/axios` and `@resili/undici` take an injected implementation, so there is nothing
extra to install unless your own code imports `axios` or `undici` directly.

```bash
npm install @resili/core@beta @resili/fetch@beta
npm install @resili/core@beta @resili/axios@beta
npm install @resili/core@beta @resili/undici@beta
```

See [HTTP adapters overview](../http/overview.md).

## LLM

`@resili/llm` is the provider-neutral foundation. Provider adapters add a thin mapping onto a vendor
SDK that **you** construct and own.

```bash
npm install @resili/core@beta @resili/llm@beta
```

Then add the adapter for your provider plus that provider's SDK. The SDK is an **optional peer
dependency**, so your package manager will not install it for you.

```bash
# OpenAI
npm install @resili/llm-openai@beta openai

# Anthropic
npm install @resili/llm-anthropic@beta @anthropic-ai/sdk

# Google Gemini
npm install @resili/llm-gemini@beta @google/genai
```

| Adapter                 | Optional peer       | Range      |
| ----------------------- | ------------------- | ---------- |
| `@resili/llm-openai`    | `openai`            | `>=4.0.0`  |
| `@resili/llm-anthropic` | `@anthropic-ai/sdk` | `>=0.20.0` |
| `@resili/llm-gemini`    | `@google/genai`     | `>=1.0.0`  |

`@resili/llm-gemini` targets the current `@google/genai` SDK. It does not support the legacy
`@google/generative-ai` package.

## Verifying an install

Every package exposes its own `package.json` through the export map, which makes version checks easy:

```bash
node -e "console.log(require('@resili/llm/package.json').version)"
```

A healthy install has exactly one copy of `@resili/core` and one copy of `@resili/llm`:

```bash
npm ls @resili/core @resili/llm
```

## Next steps

- [Quick start](quick-start.md) — first working client
- [Concepts](concepts.md) — the model behind the API
- [Package reference](../reference/packages.md) — versions, dependencies, and status
