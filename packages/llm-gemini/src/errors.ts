import { LlmError, type LlmErrorClassification } from "@resili/llm";

const SECRET_PATTERN = /AIza[0-9A-Za-z_-]+|ya29\.[0-9A-Za-z._-]+|Bearer\s+\S+/gi;

/**
 * Sanitized snapshot preserved as `LlmError.cause`.
 *
 * Intentionally excludes headers, response bodies, prompts, and API keys.
 *
 * @public
 */
export interface GeminiErrorCause {
  readonly name?: string;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestID?: string;
}

/**
 * Maps a Gemini SDK / HTTP failure to {@link LlmError}.
 *
 * Abort errors are rethrown unchanged so Resili timeout/cancel can own them.
 *
 * @internal
 */
export function mapGeminiError(error: unknown, model: string): never {
  if (isAbortLike(error)) {
    throw error;
  }

  const status = getNumber(error, "status") ?? getNumber(error, "statusCode");
  const code = getString(error, "code") ?? getGoogleStatusName(error);
  const type = getString(error, "type") ?? getGoogleStatusName(error);
  const name = getErrorName(error);
  const classification = classify(status, code, type, name);
  const retryAfterMs = readRetryAfterMs(error);

  throw new LlmError(classification, {
    provider: "gemini",
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
  const status = getNumber(error, "status");

  return name === "AbortError" || name === "DOMException" || status === 499;
}

function classify(
  status: number | undefined,
  code: string | undefined,
  type: string | undefined,
  name: string | undefined,
): LlmErrorClassification {
  const token = (code ?? type ?? "").toUpperCase();

  if (token === "UNAUTHENTICATED" || name === "AuthenticationError" || status === 401) {
    return "authentication";
  }

  if (token === "PERMISSION_DENIED" || name === "PermissionDeniedError" || status === 403) {
    return "authorization";
  }

  if (
    token === "RESOURCE_EXHAUSTED" ||
    token === "RESOURCE_EXHAUSTED_ERROR" ||
    name === "RateLimitError" ||
    status === 429
  ) {
    return "rate_limited";
  }

  if (token === "DEADLINE_EXCEEDED" || status === 408 || status === 504) {
    return "timeout";
  }

  if (isNetworkCode(code)) {
    return "network_transient";
  }

  if (token === "UNAVAILABLE" || status === 503) {
    return "overloaded";
  }

  if (name === "InternalServerError" || (status !== undefined && status >= 500)) {
    return status === 503 ? "overloaded" : "provider_unavailable";
  }

  if (
    token === "INVALID_ARGUMENT" ||
    token === "NOT_FOUND" ||
    token === "FAILED_PRECONDITION" ||
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
): GeminiErrorCause {
  const requestID =
    getString(error, "requestID") ?? getString(error, "request_id") ?? getHeaderRequestId(error);
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

function getHeaderRequestId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }

  return getHeader((error as { readonly headers: unknown }).headers, "x-request-id");
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

  if (typeof headers === "object" && !Array.isArray(headers)) {
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];

    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}

function getGoogleStatusName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return undefined;
  }

  const nested = (error as { readonly error: unknown }).error;

  return getString(nested, "status") ?? getString(nested, "code");
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

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
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
