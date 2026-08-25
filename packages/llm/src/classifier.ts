import {
  composeClassifier,
  httpClassifier,
  TimeoutError,
  type Context,
  type FailureClassifier,
  type Outcome,
} from "@resili/core";

import { isLlmError } from "./errors";

/**
 * Context metadata key for the per-logical-stream commit box.
 *
 * The box is a mutable object stored as a metadata *value*. Core copies
 * metadata shallowly and reuses the same map across timeout/retry forks, so
 * the pump can mark committed and retry classification can observe it.
 *
 * @internal
 */
export const LLM_STREAM_COMMIT_STATE_KEY = "resili.llm.streamCommit";

/**
 * Per-logical-stream commit flag. Not frozen.
 *
 * @internal
 */
export interface LlmStreamCommitState {
  committed: boolean;
}

/**
 * @internal
 */
export function createLlmStreamCommitState(): LlmStreamCommitState {
  return { committed: false };
}

/**
 * @internal
 */
export function isLlmStreamCommitted(ctx: Context): boolean {
  return getLlmStreamCommitState(ctx)?.committed === true;
}

/**
 * @internal
 */
export function markLlmStreamCommitted(ctx: Context): void {
  const state = getLlmStreamCommitState(ctx);

  if (state !== undefined) {
    state.committed = true;
  }
}

function getLlmStreamCommitState(ctx: Context): LlmStreamCommitState | undefined {
  const value: unknown = ctx.metadata.get(LLM_STREAM_COMMIT_STATE_KEY);

  if (
    typeof value === "object" &&
    value !== null &&
    "committed" in value &&
    typeof value.committed === "boolean"
  ) {
    return value as LlmStreamCommitState;
  }

  return undefined;
}

/**
 * Prevents another attempt after a logical stream has delivered user-visible
 * text. Applied around any caller classifier so custom classifiers cannot
 * retry a committed stream.
 *
 * @internal
 */
export function withStreamCommitRetryGuard(base: FailureClassifier): FailureClassifier {
  return composeClassifier(base, {
    isRetryable(outcome, ctx) {
      if (isLlmStreamCommitted(ctx)) {
        return false;
      }

      return base.isRetryable(outcome, ctx);
    },
  });
}

/**
 * Failure classifier that understands {@link LlmError} while preserving the
 * default HTTP classifier for transport errors.
 *
 * @public
 */
export const llmClassifier: FailureClassifier = composeClassifier(httpClassifier, {
  isFailure(outcome, ctx) {
    if (outcome.status === "error" && isLlmError(outcome.error)) {
      return (
        outcome.error.classification !== "budget" &&
        outcome.error.classification !== "authentication" &&
        outcome.error.classification !== "authorization" &&
        outcome.error.classification !== "invalid_request" &&
        outcome.error.classification !== "content_policy"
      );
    }

    return httpClassifier.isFailure(outcome, ctx);
  },
  isRetryable(outcome, ctx) {
    if (outcome.status === "error" && isLlmError(outcome.error)) {
      return outcome.error.retryable;
    }

    if (outcome.status === "error" && outcome.error instanceof TimeoutError) {
      return true;
    }

    return httpClassifier.isRetryable(outcome, ctx);
  },
  retryAfter(outcome: Outcome, ctx) {
    if (outcome.status === "error" && isLlmError(outcome.error)) {
      return outcome.error.retryAfterMs;
    }

    return httpClassifier.retryAfter?.(outcome, ctx);
  },
});
