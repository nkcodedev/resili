# Resili AI Prompts

## Module Planning

```text
You are working inside the Resili repository.

Follow AGENTS.md.
Read the relevant architecture documents and only the source files needed for this module.
Do not modify files.

Produce a detailed implementation plan for:
<module path>

For every interface, type, function, and public API, mark it as VERIFIED or INFERRED.
Include dependencies, execution flow, edge cases, required tests, and blockers.
Stop after the plan and wait for approval.
```

## Module Implementation

```text
The implementation plan is approved.

Follow AGENTS.md.
Implement only:
<file paths>

Do not modify unrelated files.
Do not invent public APIs.
Reuse existing interfaces.
Do not implement future modules.

After implementation, run the requested validation commands.
Fix only issues related to this module.
Show summary, diff, and validation result.
Wait for approval.
```

## Test Implementation

```text
Implement tests only for:
<module path>

Test only the behavior listed below:
<behavior list>

Do not modify production code unless a test exposes a real bug.
After implementation, run:
pnpm test

Fix only failures related to this module.
Show summary, diff, and test result.
Wait for approval.
```

## Validation

```text
Run full validation:
pnpm format
pnpm lint
pnpm -r typecheck
pnpm test
pnpm -r build
pnpm --filter @resili/core api:check

Fix only issues related to:
<scope>

Show files changed, validation summary, and remaining issues.
```

## Review

```text
Review the current changes for:
<scope>

Use a code-review stance.
Prioritize bugs, API compatibility risks, architecture violations, missing tests, and cleanup issues.
Do not modify files.
Return findings first, ordered by severity, with file references.
```

## Commit Message Preparation

```text
Prepare a Conventional Commit message for the current scoped changes.

Scope:
<scope>

Include:
- commit subject
- optional body
- files expected in the commit

Do not commit yet.
```

## Bug Fixing

```text
Fix this bug in Resili:
<bug description>

Follow AGENTS.md.
Read only the files needed to understand the bug.
Modify only files required for the fix and its tests.
Do not refactor unrelated code.
Run targeted tests first, then requested validation.
Show summary, diff, and validation result.
```

## Refactoring

```text
Refactor only:
<file paths or module>

Goal:
<refactor goal>

Do not change public behavior or public exports.
Keep tests passing.
Do not implement new features.
Run validation and report any behavior-preserving changes.
```
