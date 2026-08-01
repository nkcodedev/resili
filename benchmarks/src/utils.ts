import os from "node:os";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export interface BenchmarkOptions {
  readonly iterations: number;
  readonly warmup: number;
  readonly json: boolean;
}

export interface EnvironmentInfo {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cpus: number;
}

export interface DurationStats {
  readonly iterations: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly opsPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface BenchmarkResult {
  readonly name: string;
  readonly environment: EnvironmentInfo;
  readonly stats?: DurationStats;
  readonly details?: Readonly<Record<string, number | string | boolean>>;
}

export type Scenario = (options: BenchmarkOptions) => Promise<BenchmarkResult>;

const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_WARMUP = 1_000;

export function parseOptions(argv: readonly string[] = process.argv.slice(2)): BenchmarkOptions {
  return Object.freeze({
    iterations: parsePositiveInteger(readArg(argv, "--iterations"), DEFAULT_ITERATIONS),
    warmup: parsePositiveInteger(readArg(argv, "--warmup"), DEFAULT_WARMUP),
    json: argv.includes("--json"),
  });
}

export function isMainModule(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1];

  return entrypoint !== undefined && importMetaUrl === pathToFileURL(entrypoint).href;
}

export function environmentInfo(): EnvironmentInfo {
  const cpu = os.cpus()[0];

  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpu?.model ?? "unknown",
    cpus: os.cpus().length,
  });
}

export async function measureAsync(
  iterations: number,
  operation: (iteration: number) => Promise<unknown>,
): Promise<DurationStats> {
  const durations: number[] = [];
  const totalStartedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    await operation(iteration);
    durations.push(performance.now() - startedAt);
  }

  const totalMs = performance.now() - totalStartedAt;

  return createDurationStats(durations, totalMs);
}

export async function warmupAsync(
  iterations: number,
  operation: (iteration: number) => Promise<unknown>,
): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await operation(iteration);
  }
}

export async function runScenario(name: string, scenario: Scenario): Promise<void> {
  const options = parseOptions();
  const result = await scenario(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printResult(name, options, result);
}

export async function runAll(
  scenarios: readonly { readonly name: string; readonly run: Scenario }[],
): Promise<void> {
  const options = parseOptions();
  const results: BenchmarkResult[] = [];

  for (const scenario of scenarios) {
    results.push(await scenario.run(options));
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const result of results) {
    printResult(result.name, options, result);
    console.log("");
  }
}

export function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );

  return sortedValues[index] ?? 0;
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return Object.freeze({ promise, resolve, reject });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDurationStats(durations: readonly number[], totalMs: number): DurationStats {
  const sorted = [...durations].sort((left, right) => left - right);
  const iterations = durations.length;
  const meanMs = iterations === 0 ? 0 : totalMs / iterations;

  return Object.freeze({
    iterations,
    totalMs,
    meanMs,
    opsPerSecond: totalMs === 0 ? 0 : (iterations / totalMs) * 1_000,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  });
}

function readArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));

  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printResult(name: string, options: BenchmarkOptions, result: BenchmarkResult): void {
  console.log(name);
  console.log(
    `Environment: Node ${result.environment.node}, ${result.environment.platform}/${result.environment.arch}`,
  );
  console.log(`CPU: ${result.environment.cpu} (${String(result.environment.cpus)} logical cores)`);
  console.log(
    `Iterations: ${String(options.iterations)} measured, ${String(options.warmup)} warm-up`,
  );

  if (result.stats !== undefined) {
    console.log(`Total: ${formatMs(result.stats.totalMs)}`);
    console.log(`Mean: ${formatMs(result.stats.meanMs)}`);
    console.log(`p50: ${formatMs(result.stats.p50Ms)}`);
    console.log(`p95: ${formatMs(result.stats.p95Ms)}`);
    console.log(`p99: ${formatMs(result.stats.p99Ms)}`);
    console.log(`Throughput: ${result.stats.opsPerSecond.toFixed(2)} ops/sec`);
  }

  for (const [key, value] of Object.entries(result.details ?? {})) {
    console.log(`${key}: ${String(value)}`);
  }
}

function formatMs(value: number): string {
  return `${value.toFixed(4)} ms`;
}
