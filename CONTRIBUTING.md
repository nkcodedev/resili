# Contributing to Resili

Thanks for your interest in contributing to Resili.

Resili is a TypeScript-first resilience toolkit for Node.js. Contributions are welcome for bug fixes, documentation, tests, examples, new adapters, policy improvements, and performance work. Not every proposal will be accepted, but clear problem statements, focused changes, and tests make review easier.

## Before You Start

- Search existing issues and pull requests before opening new work.
- Open an issue before starting large features, public API changes, or behavior changes in `@resili/core`.
- Keep pull requests focused on one feature, fix, or documentation change.
- Avoid combining unrelated refactors with functional changes.
- Reuse existing interfaces and patterns instead of inventing new public APIs.
- Read the architecture and API docs before changing core behavior:
  - [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
  - [`docs/API_SPECIFICATION.md`](docs/API_SPECIFICATION.md)
  - [`docs/INTERNAL_DESIGN.md`](docs/INTERNAL_DESIGN.md)
  - [`AGENTS.md`](AGENTS.md)

## Development Setup

Resili uses pnpm workspaces and requires Node.js 20 or newer. CI currently runs on Node.js 22 with pnpm 10.

```bash
git clone https://github.com/nkcodedev/resili.git
cd resili
pnpm install
```

## Repository Layout

```text
packages/
  core/     @resili/core runtime, policies, events, metrics, plugins
  fetch/    @resili/fetch adapter
  axios/    @resili/axios adapter
  undici/   @resili/undici adapter
docs/       Architecture, API specification, internal design, feature designs
.github/    CI workflows, issue templates, pull request template
```

## Common Commands

Use the root scripts unless you are intentionally working inside one package.

```bash
pnpm format       # Check Prettier formatting
pnpm lint         # Run ESLint
pnpm typecheck    # Typecheck all workspace packages
pnpm test         # Run Vitest tests
pnpm build        # Build all workspace packages
pnpm api:check    # Run API Extractor for @resili/core
```

Additional useful commands:

```bash
pnpm test:watch   # Run Vitest in watch mode
pnpm coverage     # Run tests with coverage
pnpm docs         # Generate TypeDoc documentation
pnpm pack:check   # Pack @resili/core locally for package validation
```

## Validation Before Opening a PR

Run the same checks used by CI:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm api:check
```

If you change public exports, public types, or documented API behavior, update the API Extractor report as part of the same pull request.

## Testing

Resili uses Vitest. Add or update tests for behavior changes.

Guidelines:

- Place tests next to the code they exercise.
- Prefer deterministic tests using existing clock and context helpers.
- Avoid real sleeps, network calls, or timers when an injected clock can be used.
- Cover policy ordering and cancellation behavior when changing pipeline logic.
- Do not remove existing tests unless the tested behavior is intentionally changed and explained in the PR.

## Code Style

Follow the repository rules in [`AGENTS.md`](AGENTS.md):

- TypeScript strict mode.
- Preserve backward compatibility unless a breaking change is explicitly approved.
- Keep implementations immutable where practical.
- Prefer pure functions and focused helpers.
- Avoid unnecessary allocations and unrelated refactors.
- Do not add dependencies unless the need is clear and reviewed.

## Public API Changes

Public API changes need extra care.

Before changing exported types, builder methods, config fields, policy options, event payloads, metrics contracts, or package entry points:

1. Open an issue describing the problem and proposed API.
2. Check existing architecture and API documentation.
3. Update tests and API Extractor output.
4. Document migration impact if behavior changes.

Do not introduce future roadmap features opportunistically while working on unrelated issues.

## Branches and Pull Requests

The repository uses protected `main`, pull requests, required CI, and linear history.

- Work on a feature or documentation branch.
- Open a pull request into `main`.
- Keep the PR scoped and reviewable.
- Fill out the pull request template.
- Include validation commands and results in the PR.
- Use one logical commit per completed module when possible.

## Documentation Changes

Documentation contributions are welcome. Keep documentation aligned with implemented behavior.

When updating docs:

- Do not document unimplemented features as available.
- Keep examples short and type-correct.
- Update package README files when adapter-specific behavior changes.
- Update root README sections when public behavior or package capabilities change.

## Adapters

Current adapter packages are:

- `@resili/fetch`
- `@resili/axios`
- `@resili/undici`

New adapter proposals should start with an issue describing the target API, supported surface area, cancellation behavior, and how the adapter composes with `@resili/core`.

## Reporting Bugs

Use the bug report issue template and include:

- Node.js version.
- Package version or commit SHA.
- Minimal reproduction steps.
- Expected and actual behavior.
- Relevant logs or stack traces.

A small failing test or reproduction repository is the fastest path to a fix.

## Requesting Features

Use the feature request issue template. Describe the production problem first, then the proposed API or behavior.

For policy changes, include how the feature interacts with existing policies such as retry, timeout, circuit breaker, dedupe, hedge, cache, rate limiter, bulkhead, and fallback.

## Release Process

Release automation files are present in the repository, but release workflows are disabled unless maintainers enable them. Do not publish packages, create tags, or modify package versions unless explicitly requested by a maintainer.

## License

By contributing, you agree that your contributions will be licensed under the repository's MIT license.
