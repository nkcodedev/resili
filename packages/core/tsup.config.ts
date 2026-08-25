import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const packageDir = dirname(fileURLToPath(import.meta.url));
const coreVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  readonly version: string;
};

writeFileSync(
  join(packageDir, "src/version.ts"),
  `/**
 * Current \`@resili/core\` package version.
 *
 * Regenerated from \`package.json\` when tsup or Vitest loads. Do not edit by hand.
 *
 * @public
 */
export const RESILI_VERSION = ${JSON.stringify(coreVersion.version)} as string;
`,
);

export default defineConfig({
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
});
