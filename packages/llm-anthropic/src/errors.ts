import { LlmError, type LlmErrorClassification } from "@resili/llm";

const SECRET_PATTERN = /sk-ant-[a-zA-Z0-9_-]+|sk-[a-zA-Z0-9_-]+|Bearer\s+\S+/gi;

/**
 * Sanitized snapshot preserved as `LlmError.cause`.
 *
 * Intentionally excludes headers, response bodies, prompts, and API keys.
 *
 * @public
 */
export interface AnthropicErrorCause {
  readonly name?: string;
  readonly status?: number;
  readonly type?: string;
  readonly requestID?: string;
}

/**
 * Maps an Anthropic SDK / HTTP failure to {@link LlmError}.
 *
 * Abort errors are rethrown unchanged so Resili timeout/cancel can own them.
 *
 * @internal
 */
export function mapAnthropicError(error: unknown, model: string): never {
  if (isAbortLike(error)) {
    throw error;
  }

  const status = getNumber(error, "status") ?? getNumber(error, "statusCode");
  const type = getAnthropicType(error);
  const name = getErrorName(error);
  const classification = classify(error, status, type, name);
  const retryAfterMs = readRetryAfterMs(error);

  throw new LlmError(classification, {
    provider: "anthropic",
    model,
    cause: sanitizeCause(error, status, type),
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
  error: unknown,
  status: number | undefined,
  type: string | undefined,
  name: string | undefined,
): LlmErrorClassification {
  if (type === "overloaded_error" || status === 529) {
    return "overloaded";
  }

  if (type === "timeout_error" || name === "APIConnectionTimeoutError" || status === 408) {
    return "timeout";
  }

  if (type === "authentication_error" || name === "AuthenticationError" || status === 401) {
    return "authentication";
  }

  if (type === "permission_error" || name === "PermissionDeniedError" || status === 403) {
    return "authorization";
  }

  if (type === "rate_limit_error" || name === "RateLimitError" || status === 429) {
    return "rate_limited";
  }

  if (name === "APIConnectionError" || isNetworkCode(getString(error, "code"))) {
    return "network_transient";
  }

  if (type === "request_too_large" || status === 413) {
    return "context_limit_exceeded";
  }

  if (name === "ConflictError" || status === 409) {
    return "network_transient";
  }

  if (
    name === "InternalServerError" ||
    (status !== undefined && status >= 500) ||
    type === "api_error"
  ) {
    return status === 503 || status === 529 ? "overloaded" : "provider_unavailable";
  }

  if (
    name === "BadRequestError" ||
    name === "NotFoundError" ||
    name === "UnprocessableEntityError" ||
    type === "invalid_request_error" ||
    type === "not_found_error" ||
    type === "billing_error" ||
    status === 400 ||
    status === 402 ||
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
  type: string | undefined,
): AnthropicErrorCause {
  const requestID =
    getString(error, "requestID") ??
    getString(error, "request_id") ??
    getString(error, "_request_id");
  const name = getErrorName(error);

  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(status === undefined ? {} : { status }),
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

function getAnthropicType(error: unknown): string | undefined {
  const nested = getNestedError(error);
  return getString(nested, "type") ?? getString(error, "type");
}

function getNestedError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return undefined;
  }

  return (error as { readonly error: unknown }).error;
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
