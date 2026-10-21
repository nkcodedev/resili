import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

import { dedupeSourceMappingComments } from "../../scripts/dedupe-sourcemap-comments.mjs";

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  tsconfig: "tsconfig.tsup.json",
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  platform: "node",
  outDir: "dist",
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
  onSuccess() {
    dedupeSourceMappingComments(join(packageDir, "dist"));
  },
});
