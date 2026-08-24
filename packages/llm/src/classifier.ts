import {
  composeClassifier,
  httpClassifier,
  TimeoutError,
  type FailureClassifier,
  type Outcome,
} from "@resili/core";

import { isLlmError } from "./errors";

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
