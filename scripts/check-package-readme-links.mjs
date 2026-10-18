#!/usr/bin/env node
/**
 * Validates Markdown links in publishable package READMEs (and packed tarball
 * READMEs under temp/packed when present).
 *
 * Fails on relative paths that break on npmjs.com. Historically,
 * `[repository README](../../README.md)` in a published package resolved to
 * `https://www.npmjs.com/package/README.md`.
 *
 * GitHub `blob/main` / `tree/main` targets are checked against the local tree
 * (no network). Other external URLs are left unverified unless CHECK_EXTERNAL=1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const GH_REPO_PATH =
  /^https:\/\/github\.com\/nkcodedev\/resili\/(?:blob|tree)\/main\/(.+?)(?:#.*)?$/;
const BAD_NPM_README = /npmjs\.com\/package\/README\.md/i;
const BAD_UNAVAILABLE_SITE = /resili\.nkcode\.dev/i;

/**
 * @param {string} text
 * @returns {{ text: string, href: string }[]}
 */
function extractLinks(text) {
  const links = [];
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(text)) !== null) {
    links.push({ text: match[1], href: match[2] });
  }
  return links;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {{ severity: "error" | "warn"; message: string }[]}
 */
function validateReadme(label, text) {
  /** @type {{ severity: "error" | "warn"; message: string }[]} */
  const findings = [];

  if (BAD_NPM_README.test(text)) {
    findings.push({
      severity: "error",
      message: `${label}: contains forbidden npmjs.com/package/README.md URL`,
    });
  }

  if (BAD_UNAVAILABLE_SITE.test(text)) {
    findings.push({
      severity: "error",
      message: `${label}: contains unavailable site resili.nkcode.dev (use GitHub docs links)`,
    });
  }

  for (const { href } of extractLinks(text)) {
    if (BAD_NPM_README.test(href)) {
      findings.push({
        severity: "error",
        message: `${label}: forbidden link ${href}`,
      });
      continue;
    }

    if (href.startsWith("#") || href.startsWith("mailto:")) {
      continue;
    }

    if (href.startsWith("http://") || href.startsWith("https://")) {
      const ghPath = href.match(GH_REPO_PATH);
      if (ghPath) {
        const local = join(repoRoot, ghPath[1]);
        if (!existsSync(local)) {
          findings.push({
            severity: "error",
            message: `${label}: GitHub path missing locally: ${href} → ${relative(repoRoot, local)}`,
          });
        }
        continue;
      }
      if (
        href.startsWith("https://github.com/nkcodedev/") ||
        href.startsWith("https://www.npmjs.com/package/@resili/") ||
        href.startsWith("https://img.shields.io/")
      ) {
        continue;
      }
      if (process.env.CHECK_EXTERNAL === "1") {
        findings.push({
          severity: "warn",
          message: `${label}: external URL not auto-verified: ${href}`,
        });
      }
      continue;
    }

    findings.push({
      severity: "error",
      message: `${label}: relative link breaks on npmjs.com: (${href}) — use an absolute GitHub URL`,
    });
  }

  return findings;
}

/** @type {{ severity: "error" | "warn"; message: string }[]} */
const findings = [];

for (const name of PACKAGES) {
  const filePath = join(repoRoot, "packages", name, "README.md");
  findings.push(...validateReadme(`packages/${name}/README.md`, readFileSync(filePath, "utf8")));
}

const packedDir = join(repoRoot, "temp", "packed");
let packedCount = 0;
if (existsSync(packedDir)) {
  for (const entry of readdirSync(packedDir)) {
    if (!entry.endsWith(".tgz")) continue;
    packedCount += 1;
    const tgz = join(packedDir, entry);
    try {
      const readme = execFileSync("tar", ["-xOf", tgz, "package/README.md"], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      findings.push(...validateReadme(`packed:${entry}`, readme));
    } catch {
      findings.push({
        severity: "warn",
        message: `packed:${entry}: could not extract package/README.md for link check`,
      });
    }
  }
}

const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");
for (const f of findings) {
  console.log(`${f.severity === "error" ? "ERROR" : "WARN"}: ${f.message}`);
}

console.log(
  `package README link check: ${errors.length} error(s), ${warns.length} warning(s); scanned ${PACKAGES.length} source READMEs` +
    (packedCount ? ` + ${packedCount} packed tarballs` : ""),
);

if (errors.length > 0) {
  process.exitCode = 1;
}
