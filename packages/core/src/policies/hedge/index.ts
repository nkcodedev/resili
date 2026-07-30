import { releaseContext, type Context } from "../../core/context";
import { AbortError, ConfigurationError } from "../../core/errors";
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
  create(services: PolicyServices, options?: unknown) {
    const hedgeOptions = normalizeOptions(options);

    return {
      name: "hedge",
      order: 450,
      execute<T>(ctx: Context, next: Next<T>): Promise<T> {
        return executeWithHedge(ctx, next, services, hedgeOptions);
      },
    };
  },
});

function executeWithHedge<T>(
  ctx: Context,
  next: Next<T>,
  services: PolicyServices,
  options: NormalizedHedgeOptions,
): Promise<T> {
  return new HedgeCoordinator(ctx, next, services, options).execute();
}

type AttemptState = "running" | "settled";

interface HedgeAttempt {
  readonly hedgeAttempt: 1 | 2;
  readonly controller: AbortController;
  readonly context: Context;
  promise?: Promise<void>;
  state: AttemptState;
}

class HedgeCoordinator<T> {
  readonly #parentContext: Context;
  readonly #next: Next<T>;
  readonly #services: PolicyServices;
  readonly #options: NormalizedHedgeOptions;
  readonly #attempts: HedgeAttempt[] = [];
  readonly #result: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (error: unknown) => void;
  #hedgeTimer: ReturnType<PolicyServices["clock"]["setTimeout"]> | undefined;
  #settled = false;
  #hedgePossible = true;
  #lastFailure: unknown;
  #parentAbortCleanup: (() => void) | undefined;

  constructor(
    parentContext: Context,
    next: Next<T>,
    services: PolicyServices,
    options: NormalizedHedgeOptions,
  ) {
    this.#parentContext = parentContext;
    this.#next = next;
    this.#services = services;
    this.#options = options;
    this.#result = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  execute(): Promise<T> {
    if (this.#parentContext.signal.aborted) {
      return Promise.reject(this.#abortError());
    }

    this.#addParentAbortListener();
    this.#startAttempt(1);
    this.#scheduleHedge();

    return this.#result;
  }

  #startAttempt(hedgeAttempt: 1 | 2): void {
    if (this.#settled || this.#parentContext.signal.aborted) {
      return;
    }

    const controller = new AbortController();
    const context = this.#parentContext.fork({
      attemptNumber: this.#parentContext.attemptNumber,
      signal: controller.signal,
      metadata: { "resili.hedgeAttempt": hedgeAttempt },
    });
    const attempt: HedgeAttempt = {
      hedgeAttempt,
      controller,
      context,
      state: "running",
    };
    attempt.promise = Promise.resolve()
      .then(() => this.#next(context))
      .then(
        (value) => {
          attempt.state = "settled";
          this.#handleAttemptSuccess(attempt, value);
        },
        (error: unknown) => {
          attempt.state = "settled";
          this.#handleAttemptFailure(attempt, error);
        },
      )
      .finally(() => {
        releaseContext(context);
      });

    this.#attempts.push(attempt);
    void attempt.promise;
  }

  #scheduleHedge(): void {
    if (this.#settled || this.#parentContext.signal.aborted) {
      this.#hedgePossible = false;
      return;
    }

    if (this.#services.clock.now() + this.#options.delay >= this.#parentContext.deadline) {
      this.#hedgePossible = false;
      this.#maybeRejectWhenExhausted();
      return;
    }

    this.#hedgeTimer = this.#services.clock.setTimeout(() => {
      this.#hedgeTimer = undefined;

      if (this.#settled || this.#parentContext.signal.aborted) {
        return;
      }

      this.#hedgePossible = false;
      this.#startAttempt(2);
      this.#maybeRejectWhenExhausted();
    }, this.#options.delay);
  }

  #handleAttemptSuccess(attempt: HedgeAttempt, value: T): void {
    if (this.#settled) {
      return;
    }

    try {
      if (this.#options.shouldAccept?.(value, attempt.context) === false) {
        this.#handleAttemptFailure(attempt, createNoAcceptableResultError());
        return;
      }
    } catch (error) {
      this.#handleAttemptFailure(attempt, error);
      return;
    }

    this.#settleSuccess(attempt, value);
  }

  #handleAttemptFailure(_attempt: HedgeAttempt, error: unknown): void {
    if (this.#settled) {
      return;
    }

    this.#lastFailure = error;
    this.#maybeRejectWhenExhausted();
  }

  #maybeRejectWhenExhausted(): void {
    if (this.#settled || this.#hasRunningAttempts() || this.#hedgePossible) {
      return;
    }

    this.#settleFailure(this.#lastFailure ?? createNoAcceptableResultError());
  }

  #settleSuccess(winner: HedgeAttempt, value: T): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#cleanupTerminal();

    if (this.#options.abortLosers) {
      this.#abortLosers(winner);
    }

    this.#resolve(value);
  }

  #settleFailure(error: unknown): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#cleanupTerminal();
    this.#abortActiveAttempts();
    this.#reject(error);
  }

  #handleParentAbort(): void {
    if (this.#settled) {
      return;
    }

    this.#settled = true;
    this.#cleanupTerminal();
    this.#abortActiveAttempts();
    this.#reject(this.#abortError());
  }

  #cleanupTerminal(): void {
    if (this.#hedgeTimer !== undefined) {
      this.#services.clock.clearTimeout(this.#hedgeTimer);
      this.#hedgeTimer = undefined;
    }

    this.#parentAbortCleanup?.();
    this.#parentAbortCleanup = undefined;
    this.#hedgePossible = false;
  }

  #abortLosers(winner: HedgeAttempt): void {
    for (const attempt of this.#attempts) {
      if (attempt !== winner && attempt.state === "running") {
        attempt.controller.abort(this.#abortError());
      }
    }
  }

  #abortActiveAttempts(): void {
    const reason = this.#abortError();

    for (const attempt of this.#attempts) {
      if (attempt.state === "running") {
        attempt.controller.abort(reason);
      }
    }
  }

  #hasRunningAttempts(): boolean {
    return this.#attempts.some((attempt) => attempt.state === "running");
  }

  #addParentAbortListener(): void {
    const onAbort = (): void => {
      this.#handleParentAbort();
    };

    this.#parentContext.signal.addEventListener("abort", onAbort, { once: true });
    this.#parentAbortCleanup = () => {
      this.#parentContext.signal.removeEventListener("abort", onAbort);
    };
  }

  #abortError(): Error {
    const reason: unknown = this.#parentContext.signal.reason;

    return reason instanceof Error
      ? reason
      : new AbortError({ reason, context: this.#parentContext.snapshot() });
  }
}

function createNoAcceptableResultError(): Error {
  return new Error("No acceptable hedged result completed.");
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
