import type { Context } from "../../core/context";
import { ConfigurationError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Fallback function invoked when downstream execution fails.
 *
 * @public
 */
export type FallbackFn<R> = (error: unknown, ctx: Context) => R | Promise<R>;

/**
 * Fallback policy options.
 *
 * @public
 */
export interface FallbackOptions<R> {
  /**
   * Produces a fallback value for a handled error.
   */
  readonly handler: FallbackFn<R>;

  /**
   * Returns true when the error should be handled by the fallback.
   */
  readonly fallbackOn?: (error: unknown, ctx: Context) => boolean;
}

/**
 * Built-in fallback policy factory.
 *
 * Pass {@link FallbackOptions} as factory options.
 *
 * @public
 */
export const fallbackPolicy: PolicyFactory = definePolicy({
  name: "fallback",
  order: 100,
  create(_services: PolicyServices, options?: unknown) {
    const fallbackOptions = normalizeOptions(options);

    return {
      name: "fallback",
      order: 100,
      async execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        try {
          return await next(ctx);
        } catch (error) {
          if (fallbackOptions.fallbackOn?.(error, ctx) === false) {
            throw error;
          }

          return (await fallbackOptions.handler(error, ctx)) as T;
        }
      },
    };
  },
});

function normalizeOptions(options: unknown): FallbackOptions<unknown> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Fallback options must be an object.", { field: "fallback" });
  }

  const candidate = options as Partial<FallbackOptions<unknown>>;

  if (typeof candidate.handler !== "function") {
    throw new ConfigurationError("fallback.handler must be a function.", {
      field: "fallback.handler",
    });
  }

  if (candidate.fallbackOn !== undefined && typeof candidate.fallbackOn !== "function") {
    throw new ConfigurationError("fallback.fallbackOn must be a function.", {
      field: "fallback.fallbackOn",
    });
  }

  return Object.freeze({
    handler: candidate.handler,
    ...(candidate.fallbackOn === undefined ? {} : { fallbackOn: candidate.fallbackOn }),
  });
}
