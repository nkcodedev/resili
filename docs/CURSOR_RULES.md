# Cursor Development Rules

- Never generate code unless requested.
- Follow documentation exactly.
- Never use `any`.
- Every public API must have tests.
- Every public method needs JSDoc.
- Prefer composition over inheritance.
- Keep functions small.
- Avoid duplicated logic.
- Include:
  - Documentation
  - Examples
  - Unit Tests
  - Benchmarks

Workflow:
1. Implement one feature.
2. Run lint.
3. Run tests.
4. Fix issues.
5. Wait for approval before next feature.
