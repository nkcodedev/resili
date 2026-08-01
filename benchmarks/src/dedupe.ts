import { performance } from "node:perf_hooks";

import { resili } from "../../packages/core/src/index";
import {
  createDeferred,
  environmentInfo,
  isMainModule,
  runScenario,
  type BenchmarkOptions,
  type BenchmarkResult,
} from "./utils";

export async function dedupeBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const waveRepeats = Math.max(1, Math.min(options.iterations, 100));
  const ten = await measureSameKeyWaves(10, waveRepeats);
  const hundred = await measureSameKeyWaves(100, waveRepeats);
  const thousand = await measureSameKeyWaves(1_000, Math.max(1, Math.min(waveRepeats, 20)));
  const mixed = await measureMixedKeys(100, waveRepeats);

  return Object.freeze({
    name: "Request Deduplication",
    environment: environmentInfo(),
    details: Object.freeze({
      sameKey10Callers: 10,
      sameKey10DownstreamExecutions: ten.downstreamExecutions,
      sameKey10ReductionRatio: ten.reductionRatio,
      sameKey10TotalMs: ten.totalMs,
      sameKey100Callers: 100,
      sameKey100DownstreamExecutions: hundred.downstreamExecutions,
      sameKey100ReductionRatio: hundred.reductionRatio,
      sameKey100TotalMs: hundred.totalMs,
      sameKey1000Callers: 1_000,
      sameKey1000DownstreamExecutions: thousand.downstreamExecutions,
      sameKey1000ReductionRatio: thousand.reductionRatio,
      sameKey1000TotalMs: thousand.totalMs,
      mixedLogicalCallers: mixed.logicalCallers,
      mixedDownstreamExecutions: mixed.downstreamExecutions,
      mixedTotalMs: mixed.totalMs,
      waveRepeats,
    }),
  });
}

async function measureSameKeyWaves(
  callers: number,
  repeats: number,
): Promise<{
  readonly downstreamExecutions: number;
  readonly reductionRatio: number;
  readonly totalMs: number;
}> {
  let downstreamExecutions = 0;
  let gate = createDeferred<number>();
  const client = resili((key: string): Promise<number> => {
    void key;
    downstreamExecutions += 1;
    return gate.promise;
  })
    .dedupe({ key: (key) => key })
    .build();
  const startedAt = performance.now();

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    gate = createDeferred<number>();
    const calls = Array.from({ length: callers }, () => client.call("same-key"));
    await Promise.resolve();
    gate.resolve(repeat);
    await Promise.all(calls);
  }

  const logicalCallers = callers * repeats;

  return Object.freeze({
    downstreamExecutions,
    reductionRatio: logicalCallers / downstreamExecutions,
    totalMs: performance.now() - startedAt,
  });
}

async function measureMixedKeys(
  callers: number,
  repeats: number,
): Promise<{
  readonly logicalCallers: number;
  readonly downstreamExecutions: number;
  readonly totalMs: number;
}> {
  let downstreamExecutions = 0;
  const client = resili((key: string): Promise<string> => {
    downstreamExecutions += 1;
    return Promise.resolve(key);
  })
    .dedupe({ key: (key) => key })
    .build();
  const startedAt = performance.now();

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    await Promise.all(
      Array.from({ length: callers }, (_value, index) => client.call(`key:${String(index)}`)),
    );
  }

  return Object.freeze({
    logicalCallers: callers * repeats,
    downstreamExecutions,
    totalMs: performance.now() - startedAt,
  });
}

if (isMainModule(import.meta.url)) {
  await runScenario("Request Deduplication", dedupeBenchmark);
}
