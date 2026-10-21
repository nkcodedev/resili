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
 * Minimal structural Axios request config supported by this adapter.
 *
 * @public
 */
export interface AxiosRequestConfig<D = unknown> {
  readonly url?: string;
  readonly method?: string;
  readonly data?: D;
  readonly headers?: unknown;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

/**
 * Minimal structural Axios response supported by this adapter.
 *
 * @public
 */
export interface AxiosResponse<T = unknown, D = unknown> {
  readonly data: T;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: unknown;
  readonly config: AxiosRequestConfig<D>;
  readonly request?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Axios-compatible callable implementation used by the adapter.
 *
 * @public
 */
export type AxiosImplementation = <T = unknown, D = unknown>(
  config: AxiosRequestConfig<D>,
) => Promise<AxiosResponse<T, D>>;

/**
 * Configuration for {@link createAxios}.
 *
 * @public
 */
export interface CreateAxiosOptions extends ResiliConfig<AxiosResponse> {
  /**
   * Axios-compatible implementation to wrap.
   */
  readonly axios: AxiosImplementation;
}

/**
 * Minimal resilient Axios-compatible client.
 *
 * @public
 */
export interface ResilientAxios {
  <T = unknown, D = unknown>(config: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  on<TEvent extends ResiliEventType>(type: TEvent, handler: EventHandler<TEvent>): Unsubscribe;
  destroy(): Promise<void>;
  request<T = unknown, D = unknown>(config: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  get<T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  delete<T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  post<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  put<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  patch<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
}

/**
 * Creates a resilient wrapper around an Axios-compatible implementation.
 *
 * @public
 */
export function createAxios(options: CreateAxiosOptions): ResilientAxios {
  const candidate: unknown = options;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ConfigurationError("Axios options must be an object.", { field: "options" });
  }

  const axiosOption: unknown = (candidate as { readonly axios?: unknown }).axios;

  if (typeof axiosOption !== "function") {
    throw new ConfigurationError("options.axios must be a function.", { field: "axios" });
  }

  const axiosImplementation = axiosOption as CreateAxiosOptions["axios"];
  const client: Client<readonly [], AxiosResponse> = createClient<readonly [], AxiosResponse>(
    (): Promise<AxiosResponse> => axiosImplementation({}),
    createCoreConfig(options),
  );
  const request = <T = unknown, D = unknown>(
    config: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>> =>
    client.execute<AxiosResponse<T, D>>(
      (ctx: Context) => {
        throwIfAborted(ctx.signal);

        return Promise.resolve(axiosImplementation<T, D>({ ...config, signal: ctx.signal })).then(
          (value) => value,
          (error: unknown) => {
            throw normalizedError(error);
          },
        );
      },
      config.signal === undefined ? undefined : { signal: config.signal },
    );
  const axios = ((config: AxiosRequestConfig): Promise<AxiosResponse> =>
    request(config)) as ResilientAxios;

  axios.request = request;
  axios.get = (url, config) => request({ ...config, method: "get", url });
  axios.delete = (url, config) => request({ ...config, method: "delete", url });
  axios.post = (url, data, config) =>
    request({ ...config, ...dataPatch(data), method: "post", url });
  axios.put = (url, data, config) => request({ ...config, ...dataPatch(data), method: "put", url });
  axios.patch = (url, data, config) =>
    request({ ...config, ...dataPatch(data), method: "patch", url });
  axios.on = client.on.bind(client);
  axios.destroy = () => client.destroy();

  return Object.freeze(axios);
}

function createCoreConfig(options: CreateAxiosOptions): ResiliConfig<AxiosResponse> {
  const { axios: _axios, ...config } = options;

  void _axios;

  return config;
}

function dataPatch<D>(data: D | undefined): { readonly data?: D } {
  return data === undefined ? {} : { data };
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
