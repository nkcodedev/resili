import { createClient, type ResiliConfig } from "@resili/core";

/**
 * Fetch-compatible implementation used by the adapter.
 *
 * @public
 */
export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Configuration for {@link createFetch}.
 *
 * @public
 */
export interface CreateFetchOptions extends ResiliConfig<Response> {
  /**
   * Fetch implementation to wrap. Defaults to `globalThis.fetch`.
   */
  readonly fetch?: FetchImplementation;
}

/**
 * Fetch-compatible resilient function.
 *
 * @public
 */
export type ResilientFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Creates a resilient wrapper around native fetch.
 *
 * The adapter is intentionally thin: it delegates resilience behavior to
 * `@resili/core`, shallow-copies `RequestInit`, and lets Resili own the
 * cancellation signal for each attempt.
 *
 * @public
 */
export function createFetch(options: CreateFetchOptions = {}): ResilientFetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const client = createClient(
    (): Promise<Response> => fetchImplementation("about:blank"),
    createCoreConfig(options),
  );

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    client.execute((ctx) => fetchImplementation(input, { ...init, signal: ctx.signal }));
}

function createCoreConfig(options: CreateFetchOptions): ResiliConfig<Response> {
  const { fetch: _fetch, ...config } = options;

  void _fetch;

  return config;
}
