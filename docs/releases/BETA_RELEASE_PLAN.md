# Resili Beta Release Plan

**Status:** Milestone 7 decisions. Not a publish runbook execution log.

**Audited against:** `main` @ `4d25ac9ce948fc89b562490f99d50b56b9a2ec88`

**Companion:** [`BETA_READINESS.md`](./BETA_READINESS.md) · freeze records for Core / HTTP / LLM

This document records the chosen first-beta strategy. It does **not** bump versions, publish, tag, or move dist-tags.

---

## Verdict

**READY FOR BETA RELEASE PREP**

No remaining P0 correctness, API honesty, or packaging blockers. Next work is a dedicated release-prep branch that bumps versions, updates install docs for `@beta`, runs the release gate, publishes with `--tag beta`, then verifies from the public registry.

---

## Chosen version strategy

**Recommendation: OPTION C — align families, not the entire monorepo** (same as historical alpha lines).

| Family    | Packages                                                                           | First beta versions |
| --------- | ---------------------------------------------------------------------------------- | ------------------- |
| Core/HTTP | `@resili/core`, `@resili/fetch`, `@resili/axios`, `@resili/undici`                 | `0.2.0-beta.1`      |
| LLM       | `@resili/llm`, `@resili/llm-openai`, `@resili/llm-anthropic`, `@resili/llm-gemini` | `0.1.0-beta.1`      |

### Why not Option B (single `0.3.0-beta.1` / `1.0.0-beta.1`)

- Package history already teaches two lines (`0.2.x` core vs `0.1.x` llm).
- A monorepo-wide bump invents a false “same product version” and complicates later independent patches.
- `1.0.0-beta.1` over-claims stability for the first opt-in beta.

### Why not pure Option A without Gemini alignment

Option A’s family numbers are correct; Gemini must join the LLM beta line at `0.1.0-beta.1` so consumers do not repeat the alpha.3/alpha.4 skew.

### Semver / consumer notes

- Keep exact pins in lockfiles (`0.2.0-beta.1`, `0.1.0-beta.1`).
- Packed dependencies must rewrite to those exact versions in the same cut.
- Core/HTTP may advance without an LLM release, and vice versa, after the coordinated first beta.

---

## Gemini alignment

**Align all four LLM packages to `0.1.0-beta.1`.**

| Check                         | Finding                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| API maturity                  | Freeze candidate YES (`BETA_LLM_API_REVIEW.md`)                |
| Feature parity for beta scope | Text-in / text-out `generate` + `stream`; SDK retries disabled |
| Dependency pinning            | Gemini already packs against `@resili/llm@0.1.0-alpha.4`       |
| User clarity                  | One LLM beta version across openai / anthropic / gemini        |

Do not leave Gemini one patch behind on the first beta cut.

---

## Beta package set

Publish **all eight** packages in one coordinated cut:

1. `@resili/core`
2. `@resili/fetch`
3. `@resili/axios`
4. `@resili/undici`
5. `@resili/llm`
6. `@resili/llm-openai`
7. `@resili/llm-anthropic`
8. `@resili/llm-gemini`

No package is excluded. All eight are freeze candidates and already covered by `pnpm pack:check`.

---

## Dependency graph (packed)

```text
@resili/core
  ↑
  ├── @resili/fetch
  ├── @resili/axios
  ├── @resili/undici
  └── @resili/llm
        ↑
        ├── @resili/llm-openai
        ├── @resili/llm-anthropic
        └── @resili/llm-gemini
```

After the beta bump, packed pins must be:

- HTTP adapters → `@resili/core@0.2.0-beta.1`
- `@resili/llm` → `@resili/core@0.2.0-beta.1`
- LLM providers → `@resili/core@0.2.0-beta.1` + `@resili/llm@0.1.0-beta.1`

---

## Publish order

Publish in dependency order. HTTP adapters may run in parallel after Core. Providers may run in parallel after LLM.

1. `@resili/core@0.2.0-beta.1`
2. `@resili/fetch@0.2.0-beta.1`
3. `@resili/axios@0.2.0-beta.1`
4. `@resili/undici@0.2.0-beta.1`
5. `@resili/llm@0.1.0-beta.1`
6. `@resili/llm-openai@0.1.0-beta.1`
7. `@resili/llm-anthropic@0.1.0-beta.1`
8. `@resili/llm-gemini@0.1.0-beta.1`

Every publish uses:

```bash
pnpm publish --access public --tag beta --no-git-checks
```

Do **not** use the default tag. Do **not** move `latest`. Do **not** use `npm publish` for this cut.

---

## npm dist-tag strategy

**Recommendation: Option A — explicit prerelease opt-in.**

| Tag      | First beta cut                            | Later                                       |
| -------- | ----------------------------------------- | ------------------------------------------- |
| `beta`   | Points at `*.beta.1` for all 8            | Moves with subsequent beta / RC             |
| `alpha`  | Leave at final alpha (current)            | Freeze historical alpha; stop publishing it |
| `latest` | **Unchanged** (still old `0.1.0-alpha.1`) | Moves only on first stable `1.x`            |

Install remains deliberate:

```bash
npm install @resili/core@beta
npm install @resili/llm@beta @resili/llm-openai@beta
```

### When stable 1.0 ships

| Tag      | Action                                     |
| -------- | ------------------------------------------ |
| `latest` | Move to first stable intentionally         |
| `beta`   | Keep for RCs if needed, or leave last beta |
| `alpha`  | Historical only                            |

Reject Option B (`latest` → beta) and Option C (move `latest` to newest prerelease).

---

## Git tag / GitHub release strategy

**Recommendation: one coordinated release train tag**, not eight independent semver tags and not a single false monorepo `v0.2.0-beta.1`.

| Artifact                | Value                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| Git tag                 | `beta.1`                                                          |
| GitHub Release          | Prerelease, titled “Resili Beta 1”                                |
| Release body            | Lists all eight package versions + install `@beta` + known limits |
| Package versions on npm | Independent as in the table above                                 |

Stop conditions before tagging: any release-gate failure, unexpected dependency skew, or registry verification FAIL.

Rollback: do not move `latest`; unpublish is last resort and usually avoided — publish a corrective `*.beta.2` instead.

---

## Release gate checklist (version-bumped branch)

Run on the release-prep branch after version bumps, before publish:

1. Branch clean; based on current `main`
2. `pnpm format`
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test` (must not silently drop below 641 / 42 without a written reason)
6. `pnpm build`
7. `pnpm api:check` (all 8)
8. `pnpm pack:check`
9. Node 20 CI green
10. Node 22 CI green
11. All 8 packages packed
12. No `workspace:` / `file:` / `link:` in packed metadata
13. Exactly one resolved `@resili/core` in fresh consumer
14. Exactly one resolved `@resili/llm` in fresh consumer
15. ESM smoke all 8
16. CJS smoke all 8
17. HTTP caller cancellation smokes (fetch / axios / undici)
18. LLM `generate` smoke
19. LLM `stream` + `result` smoke
20. Post-commit timeout gate (attempts=1, RetryStarted=0, timeout/non-retryable)
21. Pre-commit retry gate
22. Package artifact safety (no `src/`, `.env`, nested tarballs, `tsbuild`, secrets)
23. Packed dependency graph matches intended beta versions
24. `git diff --check`
25. Install docs / versioning docs mention `@beta` for the cut
26. CHANGELOG has a Beta section ready to publish
27. No secrets printed in CI logs

**Count: 27 items.**

---

## Public-registry verification plan (after publish)

Use **only** npm registry packages. No tarballs, no workspace, no local `dist`.

```bash
mkdir /tmp/resili-beta-verify && cd /tmp/resili-beta-verify
npm init -y
npm install @resili/core@beta @resili/fetch@beta @resili/axios@beta @resili/undici@beta \
  @resili/llm@beta @resili/llm-openai@beta @resili/llm-anthropic@beta @resili/llm-gemini@beta
```

### PASS / FAIL criteria

| Check                 | PASS                                              |
| --------------------- | ------------------------------------------------- |
| Dist-tags             | `npm view <pkg> dist-tags.beta` = expected beta   |
| `latest`              | Unchanged from pre-publish value                  |
| Versions              | Match the beta table                              |
| Tree                  | Exactly one Core, one LLM; no nested stale copies |
| ESM / CJS             | Import and require resolve                        |
| HTTP cancellation     | Aborted signal fails without transport call       |
| LLM generate / stream | Fake injected SDKs succeed                        |
| Post-commit timeout   | Same invariants as packed gate                    |
| Pre-commit retry      | Retries still occur before commit                 |
| Tarball contents      | `npm pack` from registry matches allowlist        |

Any FAIL blocks declaring the beta cut complete.

---

## Beta release notes structure (draft)

### Title

Resili Beta 1 (`0.2.0-beta.1` core/HTTP · `0.1.0-beta.1` LLM)

### Status

Public APIs are freeze candidates. Beta may still receive fixes. This is not LTS and not `latest`.

### Highlights

- Core honesty: timeout / retry / stats / health / `RESILI_VERSION`
- HTTP caller `AbortSignal` cancellation on fetch / axios / undici
- HTTP lifecycle: `on` / `destroy`
- LLM streaming commit-point safety (post-commit timeout does not retry)
- Provider adapters: OpenAI, Anthropic, Gemini (SDK retries disabled)
- Packaging gates: pack, fresh consumer, Node 20/22, ESM/CJS, artifact safety

### Install

```bash
npm install @resili/core@beta
npm install @resili/llm@beta @resili/llm-openai@beta
```

### Known limitations

- APIs mostly frozen; justified beta fixes still possible
- Budget Guard and policy state are process-local
- No distributed `StateStore` implementation
- No TTFB / idle stream timeouts
- No tools / multimodal / embeddings / OpenAI Responses API in this cut
- HTTP status codes are not failures by default
- `latest` npm tag intentionally unchanged
- Node `>=20` (CI proves 20 and 22)

---

## Remaining work before publish (release prep only)

| Item                                         | Class                                    |
| -------------------------------------------- | ---------------------------------------- |
| Version bumps to beta.1 on all 8             | Release prep                             |
| Align Gemini to `0.1.0-beta.1`               | Release prep (decision already made)     |
| Update install / versioning docs for `@beta` | Release prep                             |
| CHANGELOG Beta section                       | Release prep                             |
| Publish + public registry verification       | Release execution                        |
| Fuller Core interaction matrix gaps          | Open during beta (not a publish blocker) |
| Node 24 CI                                   | P2                                       |

---

## Milestone map

| Milestone | Result                                   |
| --------- | ---------------------------------------- |
| 1–2       | Readiness + API freeze reviews           |
| 3         | HTTP caller cancellation                 |
| 4         | Core honesty / freeze                    |
| 5         | LLM + providers freeze                   |
| 6         | HTTP freeze + packaging + CI gates       |
| **7**     | **This plan + final readiness review**   |
| 8 (next)  | Version bump + publish + registry verify |
