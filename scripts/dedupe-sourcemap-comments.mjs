import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_MAP_COMMENT = "//# sourceMappingURL=";

/**
 * Drops consecutive duplicate sourceMappingURL comments.
 *
 * tsup with `outExtension` remapping `.js` to `.cjs` appends the comment after
 * esbuild already wrote one. Published bundles should contain the comment once.
 *
 * @param {string} distDir
 */
export function dedupeSourceMappingComments(distDir) {
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith(".js") && !name.endsWith(".cjs")) {
      continue;
    }

    const file = join(distDir, name);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const next = [];
    let previousWasMap = false;

    for (const line of lines) {
      const isMap = line.startsWith(SOURCE_MAP_COMMENT);

      if (isMap && previousWasMap) {
        continue;
      }

      next.push(line);
      previousWasMap = isMap;
    }

    const cleaned = next.join("\n");

    if (cleaned !== text) {
      writeFileSync(file, cleaned);
    }
  }
}
