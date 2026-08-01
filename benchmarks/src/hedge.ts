import { performance } from "node:perf_hooks";

import { resili, type ResiliEvent } from "../../packages/core/src/index";
import {
  environmentInfo,
  percentile,
  isMainModule,
  runScenario,
  sleep,
  type BenchmarkOptions,
  type BenchmarkResult,
  type DurationStats,
} from "./utils";

const HEDGE_DELAY_MS = 2;
const FAST_LATENCY_MS = 1;
const SLOW_LATENCY_MS = 8;

export async function hedgeBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const samples = Math.max(1, Math.min(options.iterations, 500));
  const normal = await measureNormal(samples);
  const hedged = await measureHedged(samples);

  return Object.freeze({
    name: "Hedged Requests",
    environment: environmentInfo(),
    stats: hedged.stats,
    details: Object.freeze({
      samples,
      normalMeanMs: normal.stats.meanMs,
      normalP50Ms: normal.stats.p50Ms,
      normalP95Ms: normal.stats.p95Ms,
      normalP99Ms: normal.stats.p99Ms,
      hedgedMeanMs: hedged.stats.meanMs,
      hedgedP50Ms: hedged.stats.p50Ms,
      hedgedP95Ms: hedged.stats.p95Ms,
      hedgedP99Ms: hedged.stats.p99Ms,
      normalDownstreamAttempts: normal.downstreamAttempts,
      hedgedDownstreamAttempts: hedged.downstreamAttempts,
      hedgeStartsPercent: (hedged.hedgeStarts / samples) * 100,
      hedgeWinsPercent: (hedged.hedgeWins / samples) * 100,
      hedgeDelayMs: HEDGE_DELAY_MS,
      slowEveryNthCall: 10,
    }),
  });
}

async function measureNormal(samples: number): Promise<{
  readonly stats: DurationStats;
  readonly downstreamAttempts: number;
}> {
  let downstreamAttempts = 0;
  const durations: number[] = [];
  const startedAt = performance.now();

  for (let sample = 0; sample < samples; sample += 1) {
    const callStartedAt = performance.now();
    downstreamAttempts += 1;
    await sleep(logicalLatency(sample));
    durations.push(performance.now() - callStartedAt);
  }

  return Object.freeze({
    stats: createStats(durations, performance.now() - startedAt),
    downstreamAttempts,
  });
}

async function measureHedged(samples: number): Promise<{
  readonly stats: DurationStats;
  readonly downstreamAttempts: number;
  readonly hedgeStarts: number;
  readonly hedgeWins: number;
}> {
  let downstreamAttempts = 0;
  let hedgeStarts = 0;
  let hedgeWins = 0;
  const durations: number[] = [];
  const client = resili(async (): Promise<number> => {
    const attempt = downstreamAttempts;
    downstreamAttempts += 1;
    await sleep(attemptLatency(attempt));

    return attempt;
  })
    .hedge({ delay: HEDGE_DELAY_MS })
    .build();

  client.on("HedgeStarted", () => {
    hedgeStarts += 1;
  });
  client.on(
    "HedgeCompleted",
    (event: Extract<ResiliEvent, { readonly type: "HedgeCompleted" }>) => {
      if (event.winningHedgeAttempt === 2) {
        hedgeWins += 1;
      }
    },
  );

  const startedAt = performance.now();

  for (let sample = 0; sample < samples; sample += 1) {
    const callStartedAt = performance.now();
    await client.call();
    durations.push(performance.now() - callStartedAt);
  }

  return Object.freeze({
    stats: createStats(durations, performance.now() - startedAt),
    downstreamAttempts,
    hedgeStarts,
    hedgeWins,
  });
}

function logicalLatency(sample: number): number {
  return sample % 10 === 0 ? SLOW_LATENCY_MS : FAST_LATENCY_MS;
}

function attemptLatency(attempt: number): number {
  return attempt % 10 === 0 ? SLOW_LATENCY_MS : FAST_LATENCY_MS;
}

function createStats(durations: readonly number[], totalMs: number): DurationStats {
  const sorted = [...durations].sort((left, right) => left - right);
  const iterations = durations.length;

  return Object.freeze({
    iterations,
    totalMs,
    meanMs: iterations === 0 ? 0 : totalMs / iterations,
    opsPerSecond: totalMs === 0 ? 0 : (iterations / totalMs) * 1_000,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  });
}

if (isMainModule(import.meta.url)) {
  await runScenario("Hedged Requests", hedgeBenchmark);
}
