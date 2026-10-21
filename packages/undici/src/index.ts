import {
  AbortError,
  ConfigurationError,
  createClient,
  type Client,
  type Context,
  type EventHandler,
  type ResiliConfig,
  type ResiliEventType,
  type Unsubscribe,
} from "@resili/core";

/**
 * Minimal structural Undici request options supported by this adapter.
 *
 * @public
 */
export interface UndiciRequestOptions {
  readonly origin: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

/**
 * Minimal structural Undici response supported by this adapter.
 *
 * @public
 */
export interface UndiciResponse {
  readonly statusCode: number;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Undici-compatible request implementation used by the adapter.
 *
 * @public
 */
export type UndiciImplementation = (options: UndiciRequestOptions) => Promise<UndiciResponse>;

/**
 * Configuration for {@link createUndici}.
 *
 * @public
 */
export interface CreateUndiciOptions extends ResiliConfig<UndiciResponse> {
  /**
   * Undici-compatible request implementation to wrap.
   */
  readonly request: UndiciImplementation;
}

/**
 * Minimal resilient Undici-compatible request function with Core lifecycle hooks.
 *
 * @public
 */
export interface ResilientUndici {
  (options: UndiciRequestOptions): Promise<UndiciResponse>;
  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  destroy(): Promise<void>;
}

/**
 * Creates a resilient wrapper around an Undici-compatible request function.
 *
 * @public
 */
export function createUndici(options: CreateUndiciOptions): ResilientUndici {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("Undici options must be an object.", { field: "options" });
  }

  const request: unknown = (candidate as { readonly request?: unknown }).request;

  if (typeof request !== "function") {
    throw new ConfigurationError("options.request must be a function.", { field: "request" });
  }

  const requestImplementation = request as CreateUndiciOptions["request"];
  const client: Client<readonly [], UndiciResponse> = createClient<readonly [], UndiciResponse>(
    (): Promise<UndiciResponse> => requestImplementation({ origin: "about:blank", path: "/" }),
    createCoreConfig(options),
  );

  const resilientRequest = ((requestOptions: UndiciRequestOptions): Promise<UndiciResponse> =>
    client.execute<UndiciResponse>(
      (ctx: Context) => {
        throwIfAborted(ctx.signal);

        return Promise.resolve(
          requestImplementation({ ...requestOptions, signal: ctx.signal }),
        ).then(
          (value) => value,
          (error: unknown) => {
            throw normalizedError(error);
          },
        );
      },
      requestOptions.signal === undefined ? undefined : { signal: requestOptions.signal },
    )) as ResilientUndici;

  resilientRequest.on = client.on.bind(client);
  resilientRequest.destroy = () => client.destroy();

  return Object.freeze(resilientRequest);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw toCallerAbort(signal.reason);
}

function normalizedError(error: unknown): Error {
  if (isCallerCancellationShape(error)) {
    return toCallerAbort(error);
  }

  return error instanceof Error ? error : new Error("Operation failed.", { cause: error });
}

function toCallerAbort(reason: unknown): AbortError {
  if (reason instanceof AbortError) {
    return reason;
  }

  return new AbortError({
    reason,
    ...(reason instanceof Error ? { cause: reason } : {}),
  });
}

function isCallerCancellationShape(error: unknown): boolean {
  if (error instanceof AbortError) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const name = "name" in error && typeof error.name === "string" ? error.name : undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    name === "AbortError" ||
    name === "CanceledError" ||
    code === "ERR_CANCELED" ||
    code === "ERR_ABORTED" ||
    code === "ABORT_ERR"
  );
}

function createCoreConfig(options: CreateUndiciOptions): ResiliConfig<UndiciResponse> {
  const { request: _request, ...config } = options;

  void _request;

  return config;
}
