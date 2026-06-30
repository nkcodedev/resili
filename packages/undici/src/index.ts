import { createClient, type Client, type Context, type ResiliConfig } from "@resili/core";

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
 * Minimal resilient Undici-compatible request function.
 *
 * @public
 */
export type ResilientUndici = (options: UndiciRequestOptions) => Promise<UndiciResponse>;

/**
 * Creates a resilient wrapper around an Undici-compatible request function.
 *
 * @public
 */
export function createUndici(options: CreateUndiciOptions): ResilientUndici {
  const requestImplementation = options.request;
  const client: Client<readonly [], UndiciResponse> = createClient<readonly [], UndiciResponse>(
    (): Promise<UndiciResponse> => requestImplementation({ origin: "about:blank", path: "/" }),
    createCoreConfig(options),
  );

  return (requestOptions: UndiciRequestOptions): Promise<UndiciResponse> =>
    client.execute<UndiciResponse>((ctx: Context) =>
      requestImplementation({ ...requestOptions, signal: ctx.signal }),
    );
}

function createCoreConfig(options: CreateUndiciOptions): ResiliConfig<UndiciResponse> {
  const { request: _request, ...config } = options;

  void _request;

  return config;
}
