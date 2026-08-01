# Resili Benchmarks

This directory contains a small benchmark framework for Resili request-management behavior in v0.2.

The benchmarks are intended to be reproducible local measurements, not universal performance claims. Results vary by Node.js version, CPU, operating system, power mode, background load, and repository build state.

## Scope

Current scenarios:

- **Baseline** — compares a direct async function call with the same operation wrapped by an empty Resili client.
- **Memory Cache** — measures cold misses, warm hits, repeated warm hits, and mixed-key workloads.
- **Request Deduplication** — measures same-key concurrent callers, mixed-key callers, downstream execution counts, total duration, and reduction ratio.
- **Hedged Requests** — compares normal synthetic latency with hedged execution using a deterministic latency sequence.
- **Combined Cache + Dedupe** — measures concurrent same-key cold misses followed by later cache hits.

The first benchmark set intentionally does not cover every built-in policy.

## Running Benchmarks

Run all scenarios:

```bash
pnpm benchmark
```

Run one scenario:

```bash
pnpm benchmark:baseline
pnpm benchmark:cache
pnpm benchmark:dedupe
pnpm benchmark:hedge
pnpm benchmark:combined
```

Pass a smaller or larger measured iteration count:

```bash
pnpm benchmark -- --iterations 1000 --warmup 100
```

Emit JSON output:

```bash
pnpm benchmark -- --json
pnpm benchmark:cache -- --iterations 1000 --json
```

## Output

Each result includes:

- Node.js version.
- Platform and architecture.
- CPU model and logical core count.
- Warm-up and measured iteration counts.
- Mean duration, p50, p95, p99, and throughput when the scenario measures per-call duration.
- Scenario-specific integrity counters, such as downstream execution count or hedge win percentage.

No benchmark result files are committed. Capture output locally when comparing changes.

## Interpretation Notes

- Do not compare results from different machines as if they are equivalent.
- Run benchmarks on a quiet machine when possible.
- Use the same Node.js version when comparing branches.
- Treat small differences as noise unless repeated runs show a consistent gap.
- The benchmark code avoids network calls and external services.
- Console output is outside measured loops.

## Scenario Notes

### Baseline

The baseline benchmark measures direct async-call overhead and an empty Resili client wrapping the same operation. This helps isolate framework overhead from policy behavior.

### Memory Cache

Memory Cache benchmarks report downstream execution counts. Warm hits should avoid downstream execution after the cached value has been stored.

Cache and dedupe measure different behavior:

- Cache stores completed successful values for later calls.
- Dedupe shares concurrent in-flight work and does not store completed results.

### Request Deduplication

Dedupe benchmarks create concurrent same-key waves and mixed-key waves. Same-key callers should share one downstream execution per wave. Mixed keys should execute independently.

### Hedged Requests

Hedged Requests use a deterministic synthetic latency sequence. Hedging may reduce tail latency in some workloads, but it can also increase downstream attempts. The benchmark reports both duration percentiles and downstream attempt counts.

Do not enable hedging for unsafe or non-idempotent operations.

### Combined Cache + Dedupe

The combined scenario measures a cold first wave where dedupe shares the inner work and a second wave where the completed value should be served from cache.

## Validation

Benchmark code is typechecked as part of the workspace:

```bash
pnpm typecheck
```

Before relying on benchmark changes, run:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm api:check
```
