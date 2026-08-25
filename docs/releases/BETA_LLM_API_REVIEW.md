# LLM / Provider Beta API freeze record

**Status:** Freeze candidate after Milestone 5 on `fix/llm-beta-api-lock`.

**Scope:** `@resili/llm`, `@resili/llm-openai`, `@resili/llm-anthropic`, `@resili/llm-gemini`.

This is **not** a freeze of HTTP adapters or a declaration that the whole Resili project is Beta-ready.

Runtime, tests, and packed artifacts override this document when they disagree.

## LLM Beta Freeze Candidate

| Package                 | Verdict | Notes                                                                           |
| ----------------------- | ------- | ------------------------------------------------------------------------------- |
| `@resili/llm`           | **YES** | `generate` / `stream` / `result` / Budget Guard / pricing / events / classifier |
| `@resili/llm-openai`    | **YES** | Chat Completions only; `maxRetries: 0`; structural SDK types for injection      |
| `@resili/llm-anthropic` | **YES** | Messages only; `maxRetries: 0`; structural SDK types for injection              |
| `@resili/llm-gemini`    | **YES** | `generateContent` / `generateContentStream`; `attempts: 1`; `abortSignal`       |

## Classification summary

Public exports are **KEEP** unless listed below.

| Decision           | Count (approx.)                                         | Meaning                                       |
| ------------------ | ------------------------------------------------------- | --------------------------------------------- |
| KEEP               | 91 (`llm` 53, `openai` 12, `anthropic` 11, `gemini` 15) | Freeze for remainder of Beta hardening        |
| REVIEW             | 0                                                       | —                                             |
| CHANGE BEFORE BETA | 0 remaining after this branch                           | Metrics typing + already-aborted generate     |
| INTERNALIZE        | 0                                                       | Structural SDK types stay public for DI/tests |
| DEPRECATE          | 0                                                       | —                                             |

## Client contract

- Public surface: `generate`, `stream`, `on`, `onCore`, `destroy`.
- **Not** public: Core `execute`, `call`, `stats`, `health`. Internal `createClient` still uses `execute`.
- `onCore` remains supported so callers can observe retry/timeout events.
- Unary-only providers are valid until `stream()` is called.

## Metrics design verdict

`CreateLlmClientOptions.metrics` is LLM telemetry (`resili_llm_*`). It is **not** forwarded to Core policies. Core `ResiliConfig.metrics` is omitted from the LLM options type so the two recorders cannot be confused.

## Streaming

Pull-through; commit on first **delivered** non-empty `text-delta`. Post-commit failures are not retryable, including timeout above the pump and custom classifiers.

## Packaging

LLM and provider packages emit `tsc` to `tsbuild/` so `tsc -b` cannot overwrite tsup `dist` ESM. HTTP packages still use `dist` for `tsc` (Milestone 6).

## Out of freeze

Responses API, tools, multimodal, embeddings, extra providers, distributed budget, TTFB/idle timeouts, per-chunk telemetry.
