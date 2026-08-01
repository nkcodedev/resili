import { baselineBenchmark } from "./baseline";
import { cacheBenchmark } from "./cache";
import { combinedBenchmark } from "./combined";
import { dedupeBenchmark } from "./dedupe";
import { hedgeBenchmark } from "./hedge";
import { runAll } from "./utils";

await runAll([
  { name: "Baseline", run: baselineBenchmark },
  { name: "Memory Cache", run: cacheBenchmark },
  { name: "Request Deduplication", run: dedupeBenchmark },
  { name: "Hedged Requests", run: hedgeBenchmark },
  { name: "Combined Cache + Dedupe", run: combinedBenchmark },
]);
