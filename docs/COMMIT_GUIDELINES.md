# Resili Commit Guidelines

## Conventional Commit Format

Use Conventional Commits:

```text
<type>(optional-scope): <summary>
```

The summary must be imperative, lowercase after the type, and concise. Keep the first line under 72 characters when possible.

## Commit Types

- `feat`: adds a user-facing feature or approved public capability.
- `fix`: fixes a bug.
- `test`: adds or updates tests without changing production behavior.
- `docs`: updates documentation only.
- `refactor`: changes code structure without changing behavior.
- `chore`: updates maintenance files, tooling, or generated metadata.

## Examples

```text
feat(pipeline): compile policies in canonical order
fix(context): release deadline timers on failure
test(pipeline): cover short-circuit execution
docs: add AI development workflow
refactor(policy): isolate order validation
chore: update api report
```

## Branch Naming Examples

```text
feat/pipeline
fix/context-deadline-release
test/pipeline-ordering
docs/ai-workflow
refactor/policy-ordering
chore/api-report
```

## Commit Rules

- Make one logical commit per completed module.
- Commit only files related to the approved scope.
- Do not mix feature code, refactors, and unrelated formatting in one commit.
- Do not commit generated output unless the repository expects it for the change.
- Do not commit failing tests, lint errors, type errors, or build errors unless the commit intentionally documents a known failing state.
- Mention breaking changes with a `BREAKING CHANGE:` footer and only after API review.

## Merge Rules

- Merge only after review and required validation pass.
- Squash or rebase when it produces a clearer module-level history.
- Preserve one logical commit per module where possible.
- Do not merge branches that contain unrelated worktree changes.
- Confirm API reports are up to date before merging public API changes.
