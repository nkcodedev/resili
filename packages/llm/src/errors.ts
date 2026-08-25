/**
 * Provider-neutral LLM failure classification.
 *
 * @public
 */
export type LlmErrorClassification =
  | "authentication"
  | "authorization"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "overloaded"
  | "context_limit_exceeded"
  | "content_policy"
  | "network_transient"
  | "budget"
  | "unknown";

/**
 * Stable machine-readable LLM error codes.
 *
 * @public
 */
export type LlmErrorCode =
  | "ERR_LLM_AUTH"
  | "ERR_LLM_FORBIDDEN"
  | "ERR_LLM_INVALID_REQUEST"
  | "ERR_LLM_RATE_LIMITED"
  | "ERR_LLM_TIMEOUT"
  | "ERR_LLM_UNAVAILABLE"
  | "ERR_LLM_OVERLOADED"
  | "ERR_LLM_CONTEXT_LIMIT"
  | "ERR_LLM_CONTENT_POLICY"
  | "ERR_LLM_NETWORK"
  | "ERR_LLM_BUDGET"
  | "ERR_LLM_UNKNOWN";

const LLM_ERROR_CODES = new Set<string>([
  "ERR_LLM_AUTH",
  "ERR_LLM_FORBIDDEN",
  "ERR_LLM_INVALID_REQUEST",
  "ERR_LLM_RATE_LIMITED",
  "ERR_LLM_TIMEOUT",
  "ERR_LLM_UNAVAILABLE",
  "ERR_LLM_OVERLOADED",
  "ERR_LLM_CONTEXT_LIMIT",
  "ERR_LLM_CONTENT_POLICY",
  "ERR_LLM_NETWORK",
  "ERR_LLM_BUDGET",
  "ERR_LLM_UNKNOWN",
]);

const CLASSIFICATION_CODES: Readonly<Record<LlmErrorClassification, LlmErrorCode>> = Object.freeze({
  authentication: "ERR_LLM_AUTH",
  authorization: "ERR_LLM_FORBIDDEN",
  invalid_request: "ERR_LLM_INVALID_REQUEST",
  rate_limited: "ERR_LLM_RATE_LIMITED",
  timeout: "ERR_LLM_TIMEOUT",
  provider_unavailable: "ERR_LLM_UNAVAILABLE",
  overloaded: "ERR_LLM_OVERLOADED",
  context_limit_exceeded: "ERR_LLM_CONTEXT_LIMIT",
  content_policy: "ERR_LLM_CONTENT_POLICY",
  network_transient: "ERR_LLM_NETWORK",
  budget: "ERR_LLM_BUDGET",
  unknown: "ERR_LLM_UNKNOWN",
});

const RETRYABLE_CLASSIFICATIONS = new Set<LlmErrorClassification>([
  "rate_limited",
  "timeout",
  "provider_unavailable",
  "overloaded",
  "network_transient",
]);

/**
 * Construction options for {@link LlmError}.
 *
 * @public
 */
export interface LlmErrorOptions {
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly retryable?: boolean;
  readonly message?: string;
}

/**
 * Provider-neutral LLM error.
 *
 * Messages must never include API keys, prompts, or response bodies.
 *
 * @public
 */
export class LlmError extends Error {
  /**
   * Stable machine-readable code.
   */
  readonly code: LlmErrorCode;

  /**
   * Normalized failure class.
   */
  readonly classification: LlmErrorClassification;

  /**
   * Whether retry is normally appropriate for this classification.
   */
  readonly retryable: boolean;

  /**
   * Cross-realm marker used by {@link isLlmError}.
   */
  readonly isResiliLlm = true;

  /**
   * Optional retry delay hint in milliseconds.
   */
  readonly retryAfterMs?: number;

  /**
   * Provider name when known.
   */
  readonly provider?: string;

  /**
   * Model name when known. Never a secret.
   */
  readonly model?: string;

  constructor(classification: LlmErrorClassification, options: LlmErrorOptions = {}) {
    super(options.message ?? defaultMessage(classification), { cause: options.cause });
    this.name = "LlmError";
    this.classification = classification;
    this.code = CLASSIFICATION_CODES[classification];
    this.retryable = options.retryable ?? RETRYABLE_CLASSIFICATIONS.has(classification);
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options.model !== undefined) {
      this.model = options.model;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when Budget Guard rejects a request before or instead of calling the provider.
 *
 * @public
 */
export class LlmBudgetExceededError extends LlmError {
  /**
   * Scope key that exhausted its budget.
   */
  readonly scope: string;

  /**
   * Limit that was exceeded, in micro-USD.
   */
  readonly limitMicroUsd: number;

  /**
   * Accumulated spend for the scope before this decision, in micro-USD.
   */
  readonly accumulatedMicroUsd: number;

  /**
   * Estimated or actual cost that would be added, in micro-USD.
   */
  readonly attemptedMicroUsd: number;

  /**
   * Which limit fired.
   */
  readonly limitKind: "per-request" | "accumulated" | "unknown-pricing";

  constructor(options: {
    readonly scope: string;
    readonly limitMicroUsd: number;
    readonly accumulatedMicroUsd: number;
    readonly attemptedMicroUsd: number;
    readonly limitKind: "per-request" | "accumulated" | "unknown-pricing";
    readonly provider?: string;
    readonly model?: string;
    readonly cause?: unknown;
  }) {
    super("budget", {
      message: budgetMessage(options.limitKind),
      retryable: false,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "LlmBudgetExceededError";
    this.scope = options.scope;
    this.limitMicroUsd = options.limitMicroUsd;
    this.accumulatedMicroUsd = options.accumulatedMicroUsd;
    this.attemptedMicroUsd = options.attemptedMicroUsd;
    this.limitKind = options.limitKind;
  }
}

/**
 * Returns true when a value is an LLM error from this package.
 *
 * @public
 */
export function isLlmError(error: unknown): error is LlmError {
  return (
    typeof error === "object" &&
    error !== null &&
    "isResiliLlm" in error &&
    (error as { readonly isResiliLlm: unknown }).isResiliLlm === true &&
    "code" in error &&
    typeof (error as { readonly code: unknown }).code === "string" &&
    LLM_ERROR_CODES.has((error as { readonly code: string }).code)
  );
}

/**
 * Returns whether an error is normally retryable.
 *
 * Unknown values are not retryable.
 *
 * @public
 */
export function isLlmErrorRetryable(error: unknown): boolean {
  if (isLlmError(error)) {
    return error.retryable;
  }

  return false;
}

function budgetMessage(limitKind: "per-request" | "accumulated" | "unknown-pricing"): string {
  switch (limitKind) {
    case "per-request":
      return "LLM request rejected because estimated cost exceeds the per-request budget.";
    case "accumulated":
      return "LLM request rejected because estimated cost would exceed the accumulated budget.";
    case "unknown-pricing":
      return "LLM request rejected because cost cannot be determined for this provider/model.";
  }
}

function defaultMessage(classification: LlmErrorClassification): string {
  switch (classification) {
    case "authentication":
      return "LLM authentication failed.";
    case "authorization":
      return "LLM request was not authorized.";
    case "invalid_request":
      return "LLM request was invalid.";
    case "rate_limited":
      return "LLM provider rate limit exceeded.";
    case "timeout":
      return "LLM request timed out.";
    case "provider_unavailable":
      return "LLM provider is unavailable.";
    case "overloaded":
      return "LLM provider is overloaded.";
    case "context_limit_exceeded":
      return "LLM context limit was exceeded.";
    case "content_policy":
      return "LLM provider rejected the request for content policy reasons.";
    case "network_transient":
      return "LLM request failed due to a transient network error.";
    case "budget":
      return "LLM request rejected by Budget Guard.";
    case "unknown":
      return "LLM request failed.";
  }
}
