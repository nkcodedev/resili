# Resili Development Rules

## General

- Never invent public APIs.
- Reuse existing interfaces whenever possible.
- Follow:
  - docs/ARCHITECTURE.md
  - docs/API_SPECIFICATION.md
  - docs/INTERNAL_DESIGN.md
- Do not implement future modules or roadmap items unless explicitly requested.
- If blocked by a missing interface, unclear contract, or conflicting instruction, stop and explain the blocker.

## Code Style

- TypeScript strict mode.
- Keep implementations immutable.
- Prefer pure functions.
- Avoid unnecessary allocations.

## Changes

- Modify only the requested files.
- Never change unrelated modules.
- Preserve backward compatibility.
- If a required interface does not exist, stop and explain why instead of inventing one.

## Testing

- Add or update unit tests.
- Run validation before completion.
- Run:

```bash
pnpm test
```

- Fix compile errors before finishing.

## Git

- One feature per branch.
- One logical commit per completed module.
