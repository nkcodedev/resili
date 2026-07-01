# Contributing to Resili

Thanks for helping improve Resili. This project aims to keep resilience primitives
small, typed, predictable, and production-ready.

Before contributing, read the repository rules in [`AGENTS.md`](AGENTS.md) and
the design documents in [`docs/`](docs/).

## Development Setup

Requirements:

- Node.js 20 or newer
- pnpm 10 or newer

Install dependencies:

```bash
pnpm install
```

Run the core validation loop:

```bash
pnpm lint
pnpm -r typecheck
pnpm test
pnpm -r build
```

For public API changes in `@resili/core`, also run:

```bash
pnpm --filter @resili/core api:check
```

## Branch Workflow

Use one branch per logical change:

```text
feature/retry-policy
fix/client-health-status
ci/typecheck-references
docs/package-readmes
```

Guidelines:

- Keep each branch focused on one module, bug, or documentation change.
- Do not mix refactors with feature work unless the refactor is required.
- Do not implement future roadmap items opportunistically.
- Do not change public APIs unless the API is specified and reviewed.

## Commit Message Format

Use Conventional Commits:

```text
<type>(optional-scope): <summary>
```

Common types:

- `feat`: new runtime behavior or public capability
- `fix`: bug fix
- `test`: test-only change
- `docs`: documentation-only change
- `refactor`: behavior-preserving code change
- `ci`: CI or tooling workflow change
- `chore`: maintenance task

Examples:

```text
feat(retry): add retry policy
fix(client): refine health status mapping
test(timeout): cover signal cleanup
docs: add package READMEs
ci: fix monorepo TypeScript references
```

Keep commits logical. Prefer one commit per completed module or cohesive change.

## Running Validation

Before opening a pull request, run:

```bash
pnpm exec prettier "**/*.md" --check
pnpm lint
pnpm -r typecheck
pnpm test
pnpm -r build
```

If you changed the public API for `@resili/core`, run:

```bash
pnpm --filter @resili/core api:check
```

Only update generated API reports when the public API change is intentional.

## Testing Expectations

- Add or update unit tests for behavior changes.
- Keep tests focused on the changed module.
- Cover success paths, failure paths, validation errors, and cleanup behavior.
- Prefer deterministic tests over timing-sensitive tests.
- Do not weaken strict TypeScript or ESLint rules to make tests pass.

Documentation-only changes do not require new unit tests, but examples should be
checked against the current public API where practical.

## Pull Request Checklist

Before requesting review, confirm:

- [ ] The change is limited to the intended scope.
- [ ] Public APIs match `docs/API_SPECIFICATION.md` or an approved plan.
- [ ] Existing interfaces are reused where possible.
- [ ] No future modules or roadmap items were implemented accidentally.
- [ ] Tests were added or updated for behavior changes.
- [ ] Validation commands pass locally.
- [ ] Documentation was updated when user-facing behavior changed.
- [ ] The commit history is focused and uses Conventional Commits.

## Review Standards

Reviewers should check API compatibility, TypeScript quality, architecture
alignment, test coverage, error handling, and public export boundaries. See
[`docs/REVIEW_CHECKLIST.md`](docs/REVIEW_CHECKLIST.md) for the project checklist.
