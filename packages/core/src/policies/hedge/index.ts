import type { Context } from "../../core/context";
import { ConfigurationError } from "../../core/errors";
import {
  definePolicy,
  type Next,
  type PolicyFactory,
  type PolicyServices,
} from "../../core/policy";

/**
 * Hedged request policy options.
 *
 * @public
 */
export interface HedgeOptions<T = unknown> {
  /**
   * Delay before starting the hedge attempt, in milliseconds.
   */
  readonly delay: number;

  /**
   * Maximum total executions for one logical call.
   *
   * v0.2 supports only one original execution and one hedge execution.
   */
  readonly maxAttempts?: 2;

  /**
   * Returns true when a successful value is acceptable and should win.
   */
  readonly shouldAccept?: (value: T, ctx: Context) => boolean;

  /**
   * Whether to abort losing attempts after a winner is selected.
   */
  readonly abortLosers?: boolean;
}

interface NormalizedHedgeOptions {
  readonly delay: number;
  readonly maxAttempts: 2;
  readonly abortLosers: boolean;
  readonly shouldAccept?: (value: unknown, ctx: Context) => boolean;
}

interface HedgeOptionsCandidate {
  readonly delay?: unknown;
  readonly maxAttempts?: unknown;
  readonly shouldAccept?: unknown;
  readonly abortLosers?: unknown;
}

/**
 * Built-in hedged request policy factory.
 *
 * Pass {@link HedgeOptions} as factory options.
 *
 * @public
 */
export const hedgePolicy: PolicyFactory = definePolicy({
  name: "hedge",
  order: 450,
  create(_services: PolicyServices, options?: unknown) {
    const hedgeOptions = normalizeOptions(options);

    return {
      name: "hedge",
      order: 450,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithHedge(ctx, next, hedgeOptions);
      },
    };
  },
});

function executeWithHedge<T>(
  ctx: Context,
  next: Next<T>,
  options: NormalizedHedgeOptions,
): Promise<T> {
  void options;
  // TODO: Implement duplicate execution, scheduling, result selection, and cleanup in Phase 2.
  return next(ctx);
}

function normalizeOptions(options: unknown): NormalizedHedgeOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("Hedge options must be an object.", { field: "hedge" });
  }

  const candidate = options as HedgeOptionsCandidate;
  const maxAttempts = candidate.maxAttempts ?? 2;
  const abortLosers = candidate.abortLosers ?? true;
  const delay = candidate.delay;

  validateDelay(delay);

  if (maxAttempts !== 2) {
    throw new ConfigurationError("hedge.maxAttempts must be 2 in v0.2.", {
      field: "hedge.maxAttempts",
    });
  }

  if (candidate.shouldAccept !== undefined && typeof candidate.shouldAccept !== "function") {
    throw new ConfigurationError("hedge.shouldAccept must be a function.", {
      field: "hedge.shouldAccept",
    });
  }

  if (typeof abortLosers !== "boolean") {
    throw new ConfigurationError("hedge.abortLosers must be a boolean.", {
      field: "hedge.abortLosers",
    });
  }

  return Object.freeze({
    delay,
    maxAttempts,
    abortLosers,
    ...(candidate.shouldAccept === undefined
      ? {}
      : { shouldAccept: candidate.shouldAccept as (value: unknown, ctx: Context) => boolean }),
  });
}

function validateDelay(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(
      "hedge.delay must be a finite number greater than or equal to 0.",
      {
        field: "hedge.delay",
      },
    );
  }
}
