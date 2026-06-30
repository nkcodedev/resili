# Resili Development Rules

## General

- Never invent public APIs.
- Reuse existing interfaces whenever possible.
- Follow:
  - docs/ARCHITECTURE.md
  - docs/API_SPECIFICATION.md
  - docs/INTERNAL_DESIGN.md

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
- Run:

```bash
pnpm test
```

- Fix compile errors before finishing.

## Git

- One feature per branch.
- One logical commit per completed module.