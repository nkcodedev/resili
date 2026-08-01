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

export async function cacheBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  let coldExecutions = 0;
  const coldClient = resili((key: number): Promise<number> => {
    coldExecutions += 1;
    return Promise.resolve(key);
  })
    .cache({ key: (key) => key, ttl: 60_000, maxEntries: options.iterations + options.warmup + 10 })
    .build();

  await warmupAsync(options.warmup, (iteration) => coldClient.call(-iteration - 1));
  const coldMiss = await measureAsync(options.iterations, (iteration) =>
    coldClient.call(iteration),
  );

  let warmExecutions = 0;
  const warmClient = resili((key: string): Promise<string> => {
    warmExecutions += 1;
    return Promise.resolve(`value:${key}`);
  })
    .cache({ key: (key) => key, ttl: 60_000 })
    .build();

  await warmClient.call("hot");
  await warmupAsync(options.warmup, () => warmClient.call("hot"));
  const warmHit = await measureAsync(options.iterations, () => warmClient.call("hot"));

  let mixedExecutions = 0;
  const mixedKeyCount = 100;
  const mixedClient = resili((key: number): Promise<number> => {
    mixedExecutions += 1;
    return Promise.resolve(key);
  })
    .cache({ key: (key) => key, ttl: 60_000, maxEntries: mixedKeyCount })
    .build();

  await warmupAsync(options.warmup, (iteration) => mixedClient.call(iteration % mixedKeyCount));
  const mixed = await measureAsync(options.iterations, (iteration) =>
    mixedClient.call(iteration % mixedKeyCount),
  );

  return Object.freeze({
    name: "Memory Cache",
    environment: environmentInfo(),
    stats: warmHit,
    details: Object.freeze({
      coldMissMeanMs: coldMiss.meanMs,
      warmHitMeanMs: warmHit.meanMs,
      mixedMeanMs: mixed.meanMs,
      coldDownstreamExecutions: coldExecutions,
      warmDownstreamExecutions: warmExecutions,
      mixedDownstreamExecutions: mixedExecutions,
      mixedKeyCount,
    }),
  });
}

if (isMainModule(import.meta.url)) {
  await runScenario("Memory Cache", cacheBenchmark);
}
