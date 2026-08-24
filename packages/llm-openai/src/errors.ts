import { LlmError, type LlmErrorClassification } from "@resili/llm";

const SECRET_PATTERN = /sk-[a-zA-Z0-9_-]+|Bearer\s+\S+/gi;

/**
 * Sanitized snapshot preserved as `LlmError.cause`.
 *
 * Intentionally excludes headers, response bodies, prompts, and API keys.
 *
 * @public
 */
export interface OpenAiErrorCause {
  readonly name?: string;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestID?: string;
}

/**
 * Maps an OpenAI SDK / HTTP failure to {@link LlmError}.
 *
 * Abort errors are rethrown unchanged so Resili timeout/cancel can own them.
 *
 * @internal
 */
export function mapOpenAiError(error: unknown, model: string): never {
  if (isAbortLike(error)) {
    throw error;
  }

  const status = getNumber(error, "status");
  const code = getString(error, "code");
  const type = getString(error, "type");
  const name = getErrorName(error);
  const classification = classify(status, code, type, name);
  const retryAfterMs = readRetryAfterMs(error);

  throw new LlmError(classification, {
    provider: "openai",
    model,
    cause: sanitizeCause(error, status, code, type),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * @internal
 */
export function isAbortLike(error: unknown): boolean {
  const name = getErrorName(error);

  return name === "AbortError" || name === "APIUserAbortError";
}

function classify(
  status: number | undefined,
  code: string | undefined,
  type: string | undefined,
  name: string | undefined,
): LlmErrorClassification {
  if (code === "context_length_exceeded" || type === "context_length_exceeded") {
    return "context_limit_exceeded";
  }

  if (
    code === "content_filter" ||
    code === "content_policy_violation" ||
    type === "content_policy_violation"
  ) {
    return "content_policy";
  }

  if (name === "AuthenticationError" || status === 401) {
    return "authentication";
  }

  if (name === "PermissionDeniedError" || status === 403) {
    return "authorization";
  }

  if (name === "RateLimitError" || status === 429) {
    return "rate_limited";
  }

  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return "timeout";
  }

  if (name === "APIConnectionError" || isNetworkCode(code)) {
    return "network_transient";
  }

  if (name === "InternalServerError" || (status !== undefined && status >= 500)) {
    return status === 503 ? "overloaded" : "provider_unavailable";
  }

  if (
    name === "BadRequestError" ||
    name === "NotFoundError" ||
    name === "UnprocessableEntityError" ||
    status === 400 ||
    status === 404 ||
    status === 422
  ) {
    return "invalid_request";
  }

  return "unknown";
}

function sanitizeCause(
  error: unknown,
  status: number | undefined,
  code: string | undefined,
  type: string | undefined,
): OpenAiErrorCause {
  const requestID = getString(error, "requestID") ?? getString(error, "request_id");
  const name = getErrorName(error);

  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code: redactSecrets(code) }),
    ...(type === undefined ? {} : { type: redactSecrets(type) }),
    ...(requestID === undefined ? {} : { requestID }),
  });
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }

  const headers = (error as { readonly headers: unknown }).headers;
  const raw = getHeader(headers, "retry-after");

  if (raw === undefined) {
    return undefined;
  }

  const seconds = Number(raw);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return seconds * 1_000;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) {
    return undefined;
  }

  if (typeof headers === "object" && "get" in headers) {
    const get = (headers as { readonly get: unknown }).get;

    if (typeof get === "function") {
      const value: unknown = get.call(headers, name);

      return typeof value === "string" ? value : undefined;
    }
  }

  return undefined;
}

function getNumber(error: unknown, key: string): number | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getString(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }

  const name = (error as { readonly name: unknown }).name;

  return typeof name === "string" ? name : undefined;
}

function isNetworkCode(code: string | undefined): boolean {
  return (
    code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EPIPE"
  );
}

function redactSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, "[redacted]");
}
