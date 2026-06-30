# Resili AI Workflow

## Purpose

This workflow defines how AI-assisted development should be planned, implemented, reviewed, validated, and committed in Resili. It is designed to keep changes small, auditable, and aligned with the architecture contract.

## Branch Workflow

- Use one branch per module or tightly scoped documentation change.
- Name branches by intent and scope, such as `feat/pipeline`, `test/context`, or `docs/ai-workflow`.
- Keep unrelated fixes, refactors, and generated output out of the branch.
- Rebase or merge from the main branch only when needed to resolve drift.
- Do not start another module on the same branch after the current module is complete.

## Planning Step

- Read `AGENTS.md` and the relevant architecture documents before implementation.
- Identify the exact files allowed for the task.
- List existing interfaces, functions, and types that must be reused.
- Mark gaps as blockers instead of inventing new public APIs.
- Produce an implementation plan when the task touches architecture, public API, ordering, concurrency, cancellation, state, metrics, or errors.

## Implementation Step

- Modify only the requested files.
- Reuse existing interfaces and helpers.
- Keep implementation immutable where practical.
- Prefer pure functions for deterministic logic.
- Do not implement future modules, adjacent policies, or roadmap features unless explicitly requested.
- Stop and explain if the existing source does not provide the required contract.

## Testing Step

- Add or update tests only for behavior changed in the current module.
- Keep tests deterministic and avoid wall-clock timing where fake timers or injected clocks are available.
- Cover success, failure, cancellation, cleanup, and ordering behavior when relevant.
- Do not fix unrelated failing tests in the same change.

## Validation Step

Run the project checks requested by the task. For a completed module, the expected validation set is:

```bash
pnpm format
pnpm lint
pnpm -r typecheck
pnpm test
pnpm -r build
pnpm --filter @resili/core api:check
```

If a validation failure is unrelated to the current module, report it separately and do not change unrelated files.

## Review Step

- Review the diff before handoff.
- Confirm public exports have not changed unless explicitly approved.
- Confirm all new behavior is covered by tests.
- Confirm no internal implementation detail has leaked into the public package surface.
- Confirm generated files and build artifacts are not accidentally included.

## Commit Step

- Use one logical commit per module.
- Commit only files related to the approved scope.
- Use Conventional Commit format.
- Include validation results in the handoff, not in the commit message.
- Do not commit unrelated worktree changes.

## Module Discipline

- One module per branch.
- One logical commit per module.
- One review pass per completed module before moving to the next module.
