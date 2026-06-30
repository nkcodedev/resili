import { createClient, type Client, type Context, type ResiliConfig } from "@resili/core";

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
  const axiosImplementation = options.axios;
  const client: Client<readonly [], AxiosResponse> = createClient<readonly [], AxiosResponse>(
    (): Promise<AxiosResponse> => axiosImplementation({}),
    createCoreConfig(options),
  );
  const request = <T = unknown, D = unknown>(
    config: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>> =>
    client.execute<AxiosResponse<T, D>>((ctx: Context) =>
      axiosImplementation<T, D>({ ...config, signal: ctx.signal }),
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
