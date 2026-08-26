#!/usr/bin/env node
/**
 * Packs the eight publishable Resili packages with pnpm (rewrites workspace:*)
 * and validates tarball metadata, contents, HTTP dist ownership, and a fresh
 * external consumer (ESM + CJS).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PACKAGES = Object.freeze([
  "core",
  "fetch",
  "axios",
  "undici",
  "llm",
  "llm-openai",
  "llm-anthropic",
  "llm-gemini",
]);

const HTTP_PACKAGES = Object.freeze(["fetch", "axios", "undici"]);

const FORBIDDEN_PATH_PARTS = Object.freeze([
  "/src/",
  "/node_modules/",
  "/coverage/",
  "/temp/",
  "/tsbuild/",
  "/tests/",
  "/__tests__/",
]);

const FORBIDDEN_BASENAME = Object.freeze([
  ".env",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_rsa.pub",
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectDepStrings(manifest) {
  const buckets = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
    manifest.devDependencies,
    manifest.bundleDependencies,
    manifest.bundledDependencies,
  ];
  const values = [];
  for (const bucket of buckets) {
    if (bucket == null || typeof bucket !== "object") {
      continue;
    }
    for (const value of Object.values(bucket)) {
      if (typeof value === "string") {
        values.push(value);
      }
    }
  }
  return values;
}

function assertPackedManifest(dir, packed, expected) {
  if (packed.name !== expected.name) {
    fail(`${dir}: packed name ${packed.name} !== ${expected.name}`);
  }
  if (packed.version !== expected.version) {
    fail(`${dir}: packed version ${packed.version} !== ${expected.version}`);
  }
  if (packed.engines?.node !== ">=20") {
    fail(`${dir}: engines.node must remain ">=20", got ${JSON.stringify(packed.engines)}`);
  }
  if (packed.devDependencies && Object.keys(packed.devDependencies).length > 0) {
    fail(`${dir}: packed package.json must not include devDependencies`);
  }
  const exports = packed.exports?.["."];
  if (exports?.import !== "./dist/index.js" || exports?.require !== "./dist/index.cjs") {
    fail(`${dir}: exports must expose ESM ./dist/index.js and CJS ./dist/index.cjs`);
  }
  if (exports?.types !== "./dist/index.d.ts") {
    fail(`${dir}: exports.types must be ./dist/index.d.ts`);
  }
  for (const value of collectDepStrings(packed)) {
    if (value.includes("workspace:")) {
      fail(`${dir}: packed metadata leaked workspace: (${value})`);
    }
    if (value.startsWith("link:") || value.startsWith("file:")) {
      fail(`${dir}: packed metadata leaked ${value}`);
    }
  }
  const expectedCore = readJson(join(repoRoot, "packages/core/package.json")).version;
  const expectedLlm = readJson(join(repoRoot, "packages/llm/package.json")).version;
  if (
    packed.dependencies?.["@resili/core"] != null &&
    packed.dependencies["@resili/core"] !== expectedCore
  ) {
    fail(
      `${dir}: @resili/core must pin ${expectedCore}, got ${packed.dependencies["@resili/core"]}`,
    );
  }
  if (
    packed.dependencies?.["@resili/llm"] != null &&
    packed.dependencies["@resili/llm"] !== expectedLlm
  ) {
    fail(`${dir}: @resili/llm must pin ${expectedLlm}, got ${packed.dependencies["@resili/llm"]}`);
  }
}

function assertTarballContents(dir, tarball) {
  const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const entry of listed) {
    const normalized = `/${entry.replace(/^package\//, "")}`;
    const base = entry.split("/").pop() ?? "";
    if (entry.endsWith(".tgz") || entry.endsWith(".tar.gz")) {
      fail(`${dir}: nested tarball ${entry}`);
    }
    if (FORBIDDEN_BASENAME.includes(base) || base.startsWith(".env")) {
      fail(`${dir}: forbidden file ${entry}`);
    }
    if (base.endsWith(".pem") || base.endsWith(".key")) {
      fail(`${dir}: credential-like file ${entry}`);
    }
    for (const part of FORBIDDEN_PATH_PARTS) {
      if (
        normalized.includes(part) ||
        normalized.startsWith(part.slice(0, -1) + "/") ||
        normalized === part.slice(0, -1)
      ) {
        fail(`${dir}: forbidden path ${entry}`);
      }
    }
    if (entry.includes(".test.") || entry.includes(".spec.")) {
      fail(`${dir}: test fixture packed ${entry}`);
    }
    const rel = entry.replace(/^package\//, "");
    const allowed =
      rel === "package.json" || rel === "LICENSE" || rel === "README.md" || rel.startsWith("dist/");
    if (!allowed) {
      fail(`${dir}: unexpected packed path ${entry}`);
    }
  }
}

function proveHttpDistOwnership() {
  for (const dir of HTTP_PACKAGES) {
    const distJs = join(repoRoot, "packages", dir, "dist/index.js");
    const before = sha256(distJs);
    run("pnpm", ["--filter", `@resili/${dir}`, "typecheck"], { cwd: repoRoot });
    const after = sha256(distJs);
    if (before !== after) {
      fail(`@resili/${dir}: typecheck changed dist/index.js (tsc/dist collision)`);
    }
  }
}

function countResolved(tree, name) {
  const versions = new Set();
  const visit = (node, nodeName) => {
    if (node == null || typeof node !== "object") {
      return;
    }
    if (nodeName === name && typeof node.version === "string") {
      versions.add(node.version);
    }
    if (node.name === name && typeof node.version === "string") {
      versions.add(node.version);
    }
    const deps = node.dependencies;
    if (deps != null && typeof deps === "object") {
      for (const [childName, child] of Object.entries(deps)) {
        visit(child, childName);
      }
    }
  };
  visit(tree, tree.name);
  return versions;
}

function installAndSmoke(tarballsByName) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "resili-packed-consumer-"));
  try {
    const dependencies = {};
    for (const [name, tarball] of Object.entries(tarballsByName)) {
      dependencies[name] = tarball;
    }
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify(
        {
          name: "resili-packed-consumer",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      ),
    );
    run("npm", ["install", "--ignore-scripts", "--no-package-lock"], {
      cwd: consumerRoot,
      env: { ...process.env, npm_config_update_notifier: "false" },
    });
    let lsRaw = "";
    try {
      lsRaw = execFileSync("npm", ["ls", "--all", "--json"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
      });
    } catch (error) {
      const err = error;
      lsRaw = typeof err.stdout === "string" ? err.stdout : "";
      if (lsRaw.trim() === "") {
        fail(`npm ls failed: ${err instanceof Error ? err.message : String(error)}`);
      }
    }
    const ls = JSON.parse(lsRaw);
    const coreVersions = countResolved(ls, "@resili/core");
    const llmVersions = countResolved(ls, "@resili/llm");
    if (coreVersions.size !== 1) {
      fail(`expected exactly one @resili/core, got ${[...coreVersions].join(",")}`);
    }
    if (llmVersions.size !== 1) {
      fail(`expected exactly one @resili/llm, got ${[...llmVersions].join(",")}`);
    }
    const expectedCore = readJson(join(repoRoot, "packages/core/package.json")).version;
    const expectedLlm = readJson(join(repoRoot, "packages/llm/package.json")).version;
    if ([...coreVersions][0] !== expectedCore) {
      fail(`resolved Core ${[...coreVersions][0]} !== ${expectedCore}`);
    }
    if ([...llmVersions][0] !== expectedLlm) {
      fail(`resolved LLM ${[...llmVersions][0]} !== ${expectedLlm}`);
    }
    writeFileSync(
      join(consumerRoot, "smoke-esm.mjs"),
      readFileSync(join(repoRoot, "scripts/packed-consumer/smoke-esm.mjs")),
    );
    writeFileSync(
      join(consumerRoot, "smoke-cjs.cjs"),
      readFileSync(join(repoRoot, "scripts/packed-consumer/smoke-cjs.cjs")),
    );
    run(process.execPath, [join(consumerRoot, "smoke-esm.mjs")], { cwd: consumerRoot });
    run(process.execPath, [join(consumerRoot, "smoke-cjs.cjs")], { cwd: consumerRoot });
    process.stdout.write(
      `packed consumer ok at ${consumerRoot} (not retained)\ncore=${[...coreVersions][0]} llm=${[...llmVersions][0]}\n`,
    );
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

function main() {
  const packDir = join(repoRoot, "temp", "packed");
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });

  run(
    "pnpm",
    [
      "--filter",
      "@resili/core",
      "--filter",
      "@resili/fetch",
      "--filter",
      "@resili/axios",
      "--filter",
      "@resili/undici",
      "--filter",
      "@resili/llm",
      "--filter",
      "@resili/llm-openai",
      "--filter",
      "@resili/llm-anthropic",
      "--filter",
      "@resili/llm-gemini",
      "build",
    ],
    { cwd: repoRoot },
  );

  proveHttpDistOwnership();

  const tarballsByName = {};
  for (const dir of PACKAGES) {
    const pkgDir = join(repoRoot, "packages", dir);
    const expected = readJson(join(pkgDir, "package.json"));
    const packed = run("pnpm", ["pack", "--pack-destination", packDir], { cwd: pkgDir });
    const lines = `${packed.stdout}\n${packed.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const printed = lines.at(-1);
    if (printed == null || !printed.endsWith(".tgz")) {
      fail(`pnpm pack did not print a tarball for ${dir}: ${lines.join(" | ")}`);
    }
    const tarball = printed.startsWith("/") ? printed : join(packDir, printed);
    const manifestJson = execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    });
    assertPackedManifest(dir, JSON.parse(manifestJson), expected);
    assertTarballContents(dir, tarball);
    tarballsByName[expected.name] = tarball;
    process.stdout.write(
      `packed ${expected.name}@${expected.version} ${relative(repoRoot, tarball)}\n`,
    );
  }

  installAndSmoke(tarballsByName);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
