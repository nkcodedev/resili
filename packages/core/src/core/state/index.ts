/**
 * Runtime state owned by resilience policies.
 *
 * `StateStore` is not a cache. It stores operational state such as circuit
 * breaker windows, rate-limiter tokens, and bulkhead counters. Values are
 * treated as immutable snapshots; callers should replace state through
 * {@link StateStore.set} or mutate atomically inside {@link StateStore.withLock}.
 *
 * @public
 */
export type PolicyState = Readonly<Record<string, unknown>>;

/**
 * Pluggable persistence abstraction for policy runtime state.
 *
 * Implementations may be synchronous or asynchronous. Built-in policies must
 * use this interface for shared mutable state so future Redis, DynamoDB,
 * SQLite, or shared-memory stores can be introduced without changing policy
 * code.
 *
 * @public
 */
export interface StateStore {
  /**
   * Returns the policy state stored at `key`, if present.
   */
  get<S extends PolicyState>(key: string): Promise<S | undefined> | S | undefined;

  /**
   * Replaces the policy state stored at `key`.
   */
  set(key: string, state: PolicyState): Promise<void> | void;

  /**
   * Atomically increments a numeric field in the state stored at `key`.
   *
   * Missing state and missing fields are treated as zero.
   */
  incr(key: string, field: string, by: number): Promise<number> | number;

  /**
   * Runs `fn` while holding an exclusive lock for `key`.
   *
   * This is the only supported read-modify-write primitive. Distributed state
   * stores must provide equivalent per-key atomicity.
   */
  withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Creates the default in-memory `StateStore`.
 *
 * The memory store is process-local. It is deterministic, zero-dependency, and
 * suitable for single-process clients and tests. Multi-instance deployments can
 * inject a distributed `StateStore` through the builder.
 *
 * @public
 */
export function memoryStore(): StateStore {
  return new InMemoryStateStore();
}

class InMemoryStateStore implements StateStore {
  readonly #states = new Map<string, PolicyState>();
  readonly #locks = new Map<string, Promise<void>>();

  readonly get: StateStore["get"] = <S extends PolicyState>(
    key: string,
  ): Promise<S | undefined> | S | undefined => {
    validateKey(key, "key");

    return this.#states.get(key) as unknown as S | undefined;
  };

  set(key: string, state: PolicyState): void {
    validateKey(key, "key");
    validatePolicyState(state);

    this.#states.set(key, freezePolicyState(state));
  }

  incr(key: string, field: string, by: number): number {
    validateKey(key, "key");
    validateKey(field, "field");
    validateIncrement(by);

    const current = this.#states.get(key);
    const currentValue = current?.[field];
    const numericValue = currentValue === undefined ? 0 : validateNumericField(currentValue, field);
    const nextValue = numericValue + by;

    this.#states.set(
      key,
      freezePolicyState({
        ...current,
        [field]: nextValue,
      }),
    );

    return nextValue;
  }

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    validateKey(key, "key");

    const previous = this.#locks.get(key) ?? Promise.resolve();
    let releaseCurrentLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });
    const queued = previous.then(async () => current);

    this.#locks.set(key, queued);

    try {
      await previous;

      return await fn();
    } finally {
      releaseCurrentLock();

      if (this.#locks.get(key) === queued) {
        this.#locks.delete(key);
      }
    }
  }
}

function validateKey(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function validatePolicyState(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("state must be an object.");
  }
}

function validateIncrement(value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError("increment value must be a finite number.");
  }
}

function validateNumericField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number.`);
  }

  return value;
}

function freezePolicyState(state: PolicyState): PolicyState {
  return Object.freeze({ ...state });
}
