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

export async function combinedBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const firstWaveCallers = Math.max(1, Math.min(options.iterations, 1_000));
  const secondWaveCallers = firstWaveCallers;
  let downstreamExecutions = 0;
  const gate = createDeferred<string>();
  const client = resili(async (key: string): Promise<string> => {
    downstreamExecutions += 1;
    return gate.promise.then(() => `value:${key}`);
  })
    .cache({ key: (key) => key, ttl: 60_000 })
    .dedupe({ key: (key) => key })
    .build();

  const startedAt = performance.now();
  const firstWave = Array.from({ length: firstWaveCallers }, () => client.call("same-key"));
  await Promise.resolve();
  gate.resolve("ready");
  await Promise.all(firstWave);
  const firstWaveDownstreamExecutions = downstreamExecutions;

  await Promise.all(Array.from({ length: secondWaveCallers }, () => client.call("same-key")));
  const secondWaveDownstreamExecutions = downstreamExecutions - firstWaveDownstreamExecutions;

  return Object.freeze({
    name: "Combined Cache + Dedupe",
    environment: environmentInfo(),
    details: Object.freeze({
      firstWaveLogicalCallers: firstWaveCallers,
      firstWaveDownstreamExecutions,
      secondWaveLogicalCallers: secondWaveCallers,
      secondWaveDownstreamExecutions,
      totalDownstreamExecutions: downstreamExecutions,
      totalMs: performance.now() - startedAt,
    }),
  });
}

if (isMainModule(import.meta.url)) {
  await runScenario("Combined Cache + Dedupe", combinedBenchmark);
}
