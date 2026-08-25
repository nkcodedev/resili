# Metrics

Metrics are Resili's low-cardinality observability surface: aggregate counters, gauges, and histograms
for dashboards and alerts. Anything per-request belongs in [events](events.md).

## The recorder contract

Resili does not depend on a metrics library. You supply an adapter for whatever you already run.

```ts
interface MetricsRecorder {
  counter(name: string, help?: string): Counter;
  gauge(name: string, help?: string): Gauge;
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram;
}

type Labels = Readonly<Record<string, string>>;

interface Counter {
  add(value: number, labels?: Labels): void;
}
interface Gauge {
  set(value: number, labels?: Labels): void;
}
interface Histogram {
  record(value: number, labels?: Labels): void;
}
```

`noopMetrics` is exported and is the default, so metrics cost nothing until you opt in.

A Prometheus adapter, sketched:

```ts
import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
} from "prom-client";
import type { MetricsRecorder } from "@resili/core";

const registry = new Map<string, unknown>();

export const prometheusMetrics: MetricsRecorder = {
  counter(name, help) {
    const metric = (registry.get(name) ??
      new PromCounter({
        name,
        help: help ?? name,
        labelNames: ["service", "operation", "result", "reason"],
      })) as PromCounter<string>;
    registry.set(name, metric);
    return { add: (value, labels) => metric.inc(labels ?? {}, value) };
  },
  gauge(name, help) {
    const metric = (registry.get(name) ??
      new PromGauge({
        name,
        help: help ?? name,
        labelNames: ["service", "operation"],
      })) as PromGauge<string>;
    registry.set(name, metric);
    return { set: (value, labels) => metric.set(labels ?? {}, value) };
  },
  histogram(name, help, buckets) {
    const metric = (registry.get(name) ??
      new PromHistogram({
        name,
        help: help ?? name,
        labelNames: ["service", "operation", "result"],
        buckets: buckets as number[],
      })) as PromHistogram<string>;
    registry.set(name, metric);
    return { record: (value, labels) => metric.observe(labels ?? {}, value) };
  },
};
```

Declare the union of label keys your metrics use, since Prometheus requires label names up front.

## Cardinality is a hard rule

**`requestId` must never be a metric label.** Nor may prompts, user identifiers, cache keys, URLs, or
anything else unbounded. A label with unbounded values creates a new time series per value, which will
exhaust your metrics backend.

Metric labels are for values from a small, fixed set: `result`, `reason`, `status`, `winner`,
`value_type`, plus `service` and `operation`. Per-request detail goes in events, which carry
`requestId` by design.

## Which policies record metrics

Only three: **cache**, **dedupe**, and **hedge**.

Retry, timeout, circuit breaker, rate limiter, bulkhead, and fallback record **no metrics**. They emit
[events](events.md) instead. If you need retry-rate or timeout-rate dashboards today, derive them from
events:

```ts
client.on("RetryStarted", () => myMetrics.increment("app_resili_retries_total"));
client.on("TimeoutTriggered", () => myMetrics.increment("app_resili_timeouts_total"));
client.on("CircuitOpened", (e) => myMetrics.increment("app_circuit_opened_total", { key: e.key }));
```

## Core metric names

Every core metric carries base labels `service` and `operation`.

### Cache

| Metric                            | Type      | Extra labels                                                   |
| --------------------------------- | --------- | -------------------------------------------------------------- |
| `resili_cache_hits_total`         | counter   | —                                                              |
| `resili_cache_misses_total`       | counter   | `reason`: `absent` \| `expired`                                |
| `resili_cache_stores_total`       | counter   | `value_type`: `null` \| `undefined` \| `primitive` \| `object` |
| `resili_cache_skipped_total`      | counter   | `reason`: `null_disabled` \| `undefined_disabled`              |
| `resili_cache_expired_total`      | counter   | —                                                              |
| `resili_cache_evictions_total`    | counter   | `reason`: `capacity` \| `expired_cleanup`                      |
| `resili_cache_entries`            | gauge     | —                                                              |
| `resili_cache_lookup_duration_ms` | histogram | `result`: `hit` \| `miss_absent` \| `miss_expired`             |

Hit ratio is the headline number. A high `resili_cache_evictions_total{reason="capacity"}` means
`maxEntries` is too small; remember eviction is FIFO, not LRU, so a hot key can be evicted.

### Dedupe

| Metric                                  | Type      | Extra labels                                                             |
| --------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `resili_dedupe_misses_total`            | counter   | —                                                                        |
| `resili_dedupe_joins_total`             | counter   | —                                                                        |
| `resili_dedupe_callers_total`           | counter   | `role`: `owner` \| `joiner`; `result`: `success` \| `error` \| `aborted` |
| `resili_dedupe_shared_executions_total` | counter   | `result`: `success` \| `error` \| `aborted_unused`                       |
| `resili_dedupe_duration_ms`             | histogram | `status`: `success` \| `failed` \| `aborted`                             |
| `resili_dedupe_join_wait_ms`            | histogram | `result`: `success` \| `error` \| `aborted`                              |
| `resili_dedupe_inflight`                | gauge     | —                                                                        |

`joins / (joins + misses)` is the collapse ratio — how much downstream load dedupe is saving.

### Hedge

| Metric                        | Type      | Extra labels                                                  |
| ----------------------------- | --------- | ------------------------------------------------------------- |
| `resili_hedges_started_total` | counter   | —                                                             |
| `resili_hedges_won_total`     | counter   | `winner`: `original` \| `hedge`                               |
| `resili_hedge_attempts_total` | counter   | `result`: `success` \| `error` \| `unacceptable` \| `aborted` |
| `resili_hedge_duration_ms`    | histogram | `status`: `success` \| `failed` \| `aborted`                  |
| `resili_hedge_delay_ms`       | histogram | —                                                             |

Watch `resili_hedges_won_total{winner="hedge"}`. If the hedge wins most of the time your `delay` is
too low, and you are roughly doubling downstream load for little benefit.

## LLM metric names

Supply a recorder through `createLlmClient({ metrics })`.

| Metric                                  | Type      | Labels                                                |
| --------------------------------------- | --------- | ----------------------------------------------------- |
| `resili_llm_requests_total`             | counter   | `result`: `success` \| `failure` \| `budget_rejected` |
| `resili_llm_failures_total`             | counter   | `result`: `failure`                                   |
| `resili_llm_budget_rejections_total`    | counter   | `result`: `budget_rejected`                           |
| `resili_llm_latency_ms`                 | histogram | `result`                                              |
| `resili_llm_input_tokens_total`         | counter   | `result`                                              |
| `resili_llm_output_tokens_total`        | counter   | `result`                                              |
| `resili_llm_tokens_total`               | counter   | `result`                                              |
| `resili_llm_cost_micro_usd_total`       | counter   | `result`                                              |
| `resili_llm_streams_total`              | counter   | `result`: `success` \| `failure`                      |
| `resili_llm_stream_failures_total`      | counter   | `result`: `failure`                                   |
| `resili_llm_stream_duration_ms`         | histogram | `result`                                              |
| `resili_llm_stream_ttft_ms`             | histogram | `result`                                              |
| `resili_llm_stream_chunks_total`        | counter   | `result`                                              |
| `resili_llm_stream_output_tokens_total` | counter   | `result`                                              |

**`result` is the only label.** Provider, model, prompt, user, and request id are never LLM metric
labels — model names in particular churn constantly and would create a new series per snapshot.

The practical consequence: **you cannot get per-model cost or token attribution from metrics.**
Aggregate from `LlmUsageRecorded` and `LlmRequestCompleted` events, which do carry `provider` and
`model`:

```ts
llm.on("LlmUsageRecorded", (event) => {
  costByModel.add(event.costMicroUsd ?? 0, { model: event.model }); // your own metric, your own cardinality decision
});
```

Cost is accumulated in **integer micro-USD** to avoid float drift; divide by 1,000,000 for display.

## Wiring it up

```ts
import { createClient } from "@resili/core";
import { createLlmClient } from "@resili/llm";

// Core metrics arrive through a plugin that overrides the metrics service.
const client = createClient(operation, {
  cache: { key: (id: string) => id, ttl: 10_000 },
  dedupe: { key: (id: string) => id },
});

// LLM metrics are configured directly.
const llm = createLlmClient({ provider, pricing, metrics: prometheusMetrics });
```

## Dashboard suggestions

| Question                                | Source                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Cache effectiveness                     | `resili_cache_hits_total` / (`hits` + `misses`)                           |
| Cache pressure                          | `resili_cache_evictions_total{reason="capacity"}`, `resili_cache_entries` |
| Dedupe savings                          | `resili_dedupe_joins_total` / (`joins` + `misses`)                        |
| Is hedging worth it                     | `resili_hedges_won_total{winner="hedge"}` vs `started`                    |
| LLM error rate                          | `resili_llm_failures_total` / `resili_llm_requests_total`                 |
| LLM spend rate                          | `rate(resili_llm_cost_micro_usd_total)`                                   |
| Streaming responsiveness                | `resili_llm_stream_ttft_ms` p50/p95                                       |
| Budget pressure                         | `resili_llm_budget_rejections_total`                                      |
| Retry rate, timeout rate, circuit state | Events — no metrics exist                                                 |

## Limitations

- Only cache, dedupe, and hedge record core metrics.
- LLM metrics carry a single `result` label, so no per-model breakdown.
- No built-in exporter for Prometheus, OpenTelemetry, StatsD, or anything else.
- Histogram buckets are whatever your recorder chooses; Resili passes an optional hint only.
- No metric for in-flight requests, bulkhead utilization, or rate limiter tokens.
