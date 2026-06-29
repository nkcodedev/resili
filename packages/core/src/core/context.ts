import { randomUUID } from "node:crypto";

import { systemClock } from "./clock/index";

/**
 * Input used to create a root {@link Context}.
 *
 * A root context is created once for a logical client execution. Retry policies
 * must derive attempt-specific contexts with {@link Context.fork} instead of
 * mutating this object.
 *
 * @public
 */
export interface ContextInit {
  /**
   * Correlation identifier for the logical request.
   *
   * If omitted, Resili generates a UUID.
   */
  readonly requestId?: string;

  /**
   * Human-readable operation name used by events and metrics.
   */
  readonly operationName?: string;

  /**
   * Logical downstream service name used as the default partition key.
   */
  readonly serviceName?: string;

  /**
   * One-based attempt number.
   *
   * Root contexts default to `1`. Retry attempts should use
   * {@link Context.fork} to create a fresh child context with a new attempt
   * number.
   */
  readonly attemptNumber?: number;

  /**
   * Caller-defined metadata for classifiers, policies, events, and metrics.
   *
   * Values are copied shallowly. Resili never deep-clones metadata values.
   */
  readonly metadata?: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

  /**
   * Caller-provided cancellation signal.
   *
   * The created context composes this signal with the deadline signal.
   */
  readonly signal?: AbortSignal;

  /**
   * Absolute epoch millisecond deadline for the whole logical request.
   */
  readonly deadline?: number;

  /**
   * Relative deadline budget in milliseconds.
   *
   * When both `deadline` and `deadlineMs` are supplied, `deadline` wins.
   */
  readonly deadlineMs?: number;

  /**
   * Epoch millisecond start time for the logical request.
   *
   * Defaults to `Date.now()`.
   */
  readonly startedAt?: number;
}

/**
 * Patch used to derive a child {@link Context}.
 *
 * Forking exists so every retry attempt receives a fresh context and composed
 * signal while preserving logical request identity (`requestId`, service, and
 * deadline). The parent context is never mutated.
 *
 * @public
 */
export interface ContextForkPatch {
  /**
   * One-based attempt number for the child context.
   */
  readonly attemptNumber?: number;

  /**
   * Attempt-specific timeout signal to compose with the parent signal and
   * deadline signal.
   */
  readonly signal?: AbortSignal;

  /**
   * Additional metadata to merge over the parent metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Lightweight immutable snapshot suitable for errors and telemetry payloads.
 *
 * @public
 */
export interface ContextSnapshot {
  /**
   * Correlation identifier for the logical request.
   */
  readonly requestId: string;

  /**
   * Human-readable operation name.
   */
  readonly operationName: string;

  /**
   * Logical downstream service name.
   */
  readonly serviceName: string;

  /**
   * One-based attempt number represented by the context.
   */
  readonly attemptNumber: number;
}

/**
 * Immutable execution context carried by every Resili request.
 *
 * A root context is created once per logical execution. Retry policies fork the
 * context for each attempt so attempt-local cancellation and metadata never
 * mutate parent state.
 *
 * @public
 */
export interface Context {
  /**
   * Correlation identifier, unique per logical call.
   */
  readonly requestId: string;

  /**
   * Human-readable operation name used by events and metrics.
   */
  readonly operationName: string;

  /**
   * Logical downstream service name used for partitioning and labels.
   */
  readonly serviceName: string;

  /**
   * One-based attempt number.
   */
  readonly attemptNumber: number;

  /**
   * Caller-defined metadata.
   *
   * The map is readonly and shallowly copied on creation/fork.
   */
  readonly metadata: ReadonlyMap<string, unknown>;

  /**
   * Composed cancellation signal.
   *
   * The signal represents caller cancellation, the logical request deadline,
   * and any attempt-specific timeout signal supplied through {@link Context.fork}.
   */
  readonly signal: AbortSignal;

  /**
   * Absolute epoch millisecond deadline for the logical request.
   */
  readonly deadline: number;

  /**
   * Epoch millisecond time when the root context was created.
   */
  readonly startedAt: number;

  /**
   * Returns a derived child context.
   *
   * Forking is used by retry attempts to receive a fresh composed
   * `AbortSignal`, updated attempt number, and optionally merged metadata while
   * preserving the parent's immutable request identity and deadline.
   */
  fork(patch: ContextForkPatch): Context;

  /**
   * Returns the compact immutable snapshot used by error objects and events.
   */
  snapshot(): ContextSnapshot;
}

interface InternalContextState {
  readonly requestId: string;
  readonly operationName: string;
  readonly serviceName: string;
  readonly attemptNumber: number;
  readonly metadata: ReadonlyMap<string, unknown>;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly startedAt: number;
  readonly releaseSignalResources: () => void;
}

const DEFAULT_OPERATION_NAME = "operation";
const DEFAULT_SERVICE_NAME = "default";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CONTEXT_RELEASE = new WeakMap<Context, () => void>();

/**
 * Creates an immutable root {@link Context}.
 *
 * @public
 */
export function createContext(init: ContextInit = {}): Context {
  validateContextInit(init);

  const startedAt = init.startedAt ?? systemClock.now();
  const deadline = resolveDeadline(startedAt, init.deadline, init.deadlineMs);
  const composedSignal = composeSignals(init.signal === undefined ? [] : [init.signal], deadline);

  return createTrackedContext({
    requestId: init.requestId ?? randomUUID(),
    operationName: init.operationName ?? DEFAULT_OPERATION_NAME,
    serviceName: init.serviceName ?? DEFAULT_SERVICE_NAME,
    attemptNumber: init.attemptNumber ?? 1,
    metadata: toReadonlyMetadata(init.metadata),
    signal: composedSignal.signal,
    deadline,
    startedAt,
    releaseSignalResources: composedSignal.release,
  });
}

/**
 * Releases internal resources associated with a {@link Context}.
 *
 * This is an internal lifecycle hook for the future pipeline/client execution
 * coordinator. It is intentionally not exported from the package root.
 */
export function releaseContext(context: Context): void {
  CONTEXT_RELEASE.get(context)?.();
  CONTEXT_RELEASE.delete(context);
}

class ResiliContext implements Context {
  readonly #requestId: string;
  readonly #operationName: string;
  readonly #serviceName: string;
  readonly #attemptNumber: number;
  readonly #metadata: ReadonlyMap<string, unknown>;
  readonly #signal: AbortSignal;
  readonly #deadline: number;
  readonly #startedAt: number;
  readonly #releaseSignalResources: () => void;

  constructor(state: InternalContextState) {
    this.#requestId = state.requestId;
    this.#operationName = state.operationName;
    this.#serviceName = state.serviceName;
    this.#attemptNumber = state.attemptNumber;
    this.#metadata = state.metadata;
    this.#signal = state.signal;
    this.#deadline = state.deadline;
    this.#startedAt = state.startedAt;
    this.#releaseSignalResources = state.releaseSignalResources;

    Object.freeze(this);
  }

  get requestId(): string {
    return this.#requestId;
  }

  get operationName(): string {
    return this.#operationName;
  }

  get serviceName(): string {
    return this.#serviceName;
  }

  get attemptNumber(): number {
    return this.#attemptNumber;
  }

  get metadata(): ReadonlyMap<string, unknown> {
    return this.#metadata;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  get deadline(): number {
    return this.#deadline;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  fork(patch: ContextForkPatch): Context {
    validateContextForkPatch(patch);
    const composedSignal = composeSignals(
      patch.signal === undefined ? [this.#signal] : [this.#signal, patch.signal],
      this.#deadline,
    );

    return createTrackedContext({
      requestId: this.#requestId,
      operationName: this.#operationName,
      serviceName: this.#serviceName,
      attemptNumber: patch.attemptNumber ?? this.#attemptNumber + 1,
      metadata: mergeMetadata(this.#metadata, patch.metadata),
      signal: composedSignal.signal,
      deadline: this.#deadline,
      startedAt: this.#startedAt,
      releaseSignalResources: composedSignal.release,
    });
  }

  snapshot(): ContextSnapshot {
    return Object.freeze({
      requestId: this.#requestId,
      operationName: this.#operationName,
      serviceName: this.#serviceName,
      attemptNumber: this.#attemptNumber,
    });
  }

  releaseSignalResources(): void {
    this.#releaseSignalResources();
  }
}

function createTrackedContext(state: InternalContextState): Context {
  const context = new ResiliContext(state);

  CONTEXT_RELEASE.set(context, () => {
    context.releaseSignalResources();
  });

  return context;
}

const MUTATING_METADATA_PROPERTIES = new Set<PropertyKey>(["set", "delete", "clear"]);

function validateContextInit(init: ContextInit): void {
  validateOptionalNonEmptyString(init.requestId, "requestId");
  validateOptionalNonEmptyString(init.operationName, "operationName");
  validateOptionalNonEmptyString(init.serviceName, "serviceName");
  validateAttemptNumber(init.attemptNumber, "attemptNumber");
  validateOptionalFiniteNumber(init.deadline, "deadline");
  validateOptionalFiniteNumber(init.deadlineMs, "deadlineMs");
  validateOptionalFiniteNumber(init.startedAt, "startedAt");
  validateOptionalAbortSignal(init.signal, "signal");
  validateMetadata(init.metadata, "metadata");

  if (init.deadlineMs !== undefined && init.deadlineMs < 0) {
    throw new RangeError("deadlineMs must be greater than or equal to 0.");
  }
}

function validateContextForkPatch(patch: ContextForkPatch): void {
  validateAttemptNumber(patch.attemptNumber, "attemptNumber");
  validateOptionalAbortSignal(patch.signal, "signal");
  validateMetadata(patch.metadata, "metadata");
}

function validateOptionalNonEmptyString(value: string | undefined, field: string): void {
  if (value?.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function validateAttemptNumber(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new RangeError(`${field} must be a positive integer.`);
  }
}

function validateOptionalFiniteNumber(value: number | undefined, field: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new RangeError(`${field} must be a finite number.`);
  }
}

function validateOptionalAbortSignal(value: AbortSignal | undefined, field: string): void {
  if (value !== undefined && !isAbortSignal(value)) {
    throw new TypeError(`${field} must be an AbortSignal.`);
  }
}

function validateMetadata(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object or ReadonlyMap.`);
  }

  if (isReadonlyMap(value)) {
    for (const [key] of value) {
      validateMetadataKey(key, field);
    }

    return;
  }

  for (const key of Object.keys(value)) {
    validateMetadataKey(key, field);
  }
}

function validateMetadataKey(key: unknown, field: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(`${field} keys must be non-empty strings.`);
  }
}

function resolveDeadline(
  startedAt: number,
  deadline: number | undefined,
  deadlineMs: number | undefined,
): number {
  if (deadline !== undefined) {
    return deadline;
  }

  if (deadlineMs !== undefined) {
    return startedAt + deadlineMs;
  }

  return Number.POSITIVE_INFINITY;
}

function toReadonlyMetadata(
  metadata: ContextInit["metadata"] | ContextForkPatch["metadata"],
): ReadonlyMap<string, unknown> {
  if (metadata === undefined) {
    return createReadonlyMetadataMap([]);
  }

  if (isReadonlyMap(metadata)) {
    return createReadonlyMetadataMap(metadata);
  }

  return createReadonlyMetadataMap(Object.entries(metadata));
}

function mergeMetadata(
  parent: ReadonlyMap<string, unknown>,
  patch: ContextForkPatch["metadata"],
): ReadonlyMap<string, unknown> {
  if (patch === undefined) {
    return parent;
  }

  return createReadonlyMetadataMap([...parent, ...Object.entries(patch)]);
}

function createReadonlyMetadataMap(
  entries: Iterable<readonly [string, unknown]>,
): ReadonlyMap<string, unknown> {
  const map = new Map(entries);

  const proxy: ReadonlyMap<string, unknown> = new Proxy(map, {
    get(target, property) {
      if (MUTATING_METADATA_PROPERTIES.has(property)) {
        return undefined;
      }

      if (property === "forEach") {
        return (
          callbackfn: (value: unknown, key: string, map: ReadonlyMap<string, unknown>) => void,
          thisArg?: unknown,
        ): void => {
          for (const [key, value] of target) {
            callbackfn.call(thisArg, value, key, proxy);
          }
        };
      }

      const value: unknown = Reflect.get(target, property, target);

      if (typeof value === "function") {
        const boundValue: unknown = value.bind(target);

        return boundValue;
      }

      return value;
    },
    has(target, property) {
      return !MUTATING_METADATA_PROPERTIES.has(property) && property in target;
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    defineProperty() {
      return false;
    },
  });

  return proxy;
}

interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

function composeSignals(signals: readonly AbortSignal[], deadline: number): ComposedSignal {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  let deadlineTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let released = false;

  const release = (): void => {
    if (released) {
      return;
    }

    released = true;

    if (deadlineTimer !== undefined) {
      systemClock.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }

    for (const cleanup of cleanups) {
      cleanup();
    }

    cleanups.length = 0;
  };

  const abort = (reason: unknown): void => {
    release();
    controller.abort(reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason);
      return { signal: controller.signal, release };
    }

    const onAbort = (): void => {
      abort(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  if (Number.isFinite(deadline)) {
    const delay = deadline - systemClock.now();

    if (delay <= 0) {
      abort(createDeadlineAbortReason());
      return { signal: controller.signal, release };
    }

    deadlineTimer = systemClock.setTimeout(
      () => {
        abort(createDeadlineAbortReason());
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
  }

  return { signal: controller.signal, release };
}

function createDeadlineAbortReason(): DOMException {
  return new DOMException("Deadline exceeded.", "AbortError");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { readonly aborted: unknown }).aborted === "boolean" &&
    "addEventListener" in value &&
    typeof (value as { readonly addEventListener: unknown }).addEventListener === "function"
  );
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    typeof (value as { readonly entries: unknown }).entries === "function" &&
    "get" in value &&
    typeof (value as { readonly get: unknown }).get === "function" &&
    "has" in value &&
    typeof (value as { readonly has: unknown }).has === "function"
  );
}
