# Resili Review Checklist

## API Compatibility Checklist

- Public exports are unchanged unless the API specification explicitly approves the change.
- Public type names, method names, option names, and error codes remain backward compatible.
- No concrete internal policy classes are exported.
- No deep-import path is introduced or documented as supported.
- New public API, if any, is documented in `docs/API_SPECIFICATION.md`.

## TypeScript Quality Checklist

- Code compiles under strict TypeScript settings.
- No `any` is introduced in public or internal contracts.
- Existing interfaces and types are reused.
- Type assertions are narrow, justified, and not used to hide design gaps.
- Immutable inputs and readonly outputs are preserved where expected.

## Architecture Checklist

- The implementation follows `docs/ARCHITECTURE.md`.
- The public surface follows `docs/API_SPECIFICATION.md`.
- Internal design follows `docs/INTERNAL_DESIGN.md`.
- Pipeline and policy ordering follow the canonical order.
- State, time, events, metrics, and classification stay behind their existing abstractions.
- Future modules and roadmap features are not implemented early.

## Test Coverage Checklist

- Tests cover the requested behavior and edge cases.
- Tests are deterministic and avoid unnecessary wall-clock timing.
- Failure paths and cleanup paths are covered.
- Ordering, cancellation, state mutation, and concurrency are covered when relevant.
- No unrelated tests are rewritten to make the change pass.

## Performance Checklist

- Hot paths avoid avoidable allocations.
- Work that can be done at build or compile time is not repeated per request.
- No unbounded queues, timers, listeners, or maps are introduced.
- No background polling is introduced without an approved design.
- Metrics labels remain low-cardinality.

## Error Handling Checklist

- Original causes are preserved where errors are wrapped.
- Public error classes are used only where part of the approved API.
- Cleanup happens in `finally` blocks for timers, listeners, permits, and context resources.
- Event listener failures cannot break request execution.
- Runtime validation failures are clear and actionable.

## Public Export Checklist

- Package root exports are reviewed before merge.
- API Extractor output is checked when public declarations may change.
- Internal modules remain internal.
- Test helpers and fakes are not exported from the package root.
- Documentation examples use only supported public APIs.
