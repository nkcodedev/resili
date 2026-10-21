# Installation

Resili is published as independently versioned packages. Install only what you use.

## Requirements

- Node.js **20 or newer** (every package declares `"engines": { "node": ">=20" }`)
- TypeScript is optional but supported; every package ships `.d.ts` and `.d.cts` declarations
- Both ESM `import` and CommonJS `require()` are supported through conditional exports

## Current release channel

**RC2 is published on npm `next`** (`0.2.0-rc.2` / `0.1.0-rc.2`). Plain installs still resolve to
Beta 1 (`latest` / `beta`). Historical alpha builds remain under `@alpha`. RC1 remains available
as exact versions (`0.2.0-rc.1` / `0.1.0-rc.1`). This is not a stable release — pin exact versions
when you need reproducibility. See [Versioning and dist-tags](../releases/versioning.md) and
[RC2 status](../releases/rc2-status.md).

```bash
# Default install (Beta 1 on latest)
npm install @resili/core

# Published release candidate (npm next)
npm install @resili/core@next
npm install @resili/core@0.2.0-rc.2
```

## Core

`@resili/core` has **zero runtime dependencies** and is the only required package.

```bash
npm install @resili/core
```

## HTTP adapters

Each adapter depends only on `@resili/core`. None of them bundles or requires the underlying HTTP
library — `@resili/axios` and `@resili/undici` take an injected implementation, so there is nothing
extra to install unless your own code imports `axios` or `undici` directly.

```bash
npm install @resili/core @resili/fetch
npm install @resili/core @resili/axios
npm install @resili/core @resili/undici
```

See [HTTP adapters overview](../http/overview.md).

## LLM

`@resili/llm` is the provider-neutral foundation. Provider adapters add a thin mapping onto a vendor
SDK that **you** construct and own.

```bash
npm install @resili/core @resili/llm
```

Then add the adapter for your provider plus that provider's SDK. The SDK is an **optional peer
dependency**, so your package manager will not install it for you.

```bash
# OpenAI
npm install @resili/llm-openai openai

# Anthropic
npm install @resili/llm-anthropic @anthropic-ai/sdk

# Google Gemini
npm install @resili/llm-gemini @google/genai
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
