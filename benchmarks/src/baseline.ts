import { resili } from "../../packages/core/src/index";
import {
  environmentInfo,
  measureAsync,
  isMainModule,
  runScenario,
  warmupAsync,
  type BenchmarkOptions,
  type BenchmarkResult,
} from "./utils";

export async function baselineBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const operation = (value: number): Promise<number> => Promise.resolve(value + 1);
  const client = resili(operation).build();

  await warmupAsync(options.warmup, (iteration) => operation(iteration));
  const direct = await measureAsync(options.iterations, (iteration) => operation(iteration));

  await warmupAsync(options.warmup, (iteration) => client.call(iteration));
  const wrapped = await measureAsync(options.iterations, (iteration) => client.call(iteration));

  return Object.freeze({
    name: "Baseline",
    environment: environmentInfo(),
    stats: wrapped,
    details: Object.freeze({
      directMeanMs: direct.meanMs,
      directOpsPerSecond: direct.opsPerSecond,
      wrappedMeanMs: wrapped.meanMs,
      wrappedOpsPerSecond: wrapped.opsPerSecond,
      overheadMeanMs: Math.max(0, wrapped.meanMs - direct.meanMs),
    }),
  });
}

if (isMainModule(import.meta.url)) {
  await runScenario("Baseline", baselineBenchmark);
}
