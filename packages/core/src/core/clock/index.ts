/**
 * Native timer handle returned by the platform timer implementation.
 *
 * This alias is intentionally internal to the `Clock` contract so Resili can
 * run on Node.js while keeping the public API independent of a concrete timer
 * class.
 */
/**
 * Injectable source of wall-clock time and timers.
 *
 * Resili policies must obtain time through this abstraction rather than calling
 * `Date.now()` or global timer functions directly. This makes retry backoff,
 * timeout scheduling, circuit-breaker windows, rate limiting, event timestamps,
 * and tests deterministic.
 *
 * @public
 */
export interface Clock {
  /**
   * Returns the current wall-clock time as epoch milliseconds.
   */
  now(): number;

  /**
   * Schedules `callback` to run after `ms` milliseconds.
   *
   * The returned handle must be passed to {@link Clock.clearTimeout} if the
   * timer is no longer needed.
   */
  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;

  /**
   * Cancels a timer previously returned by {@link Clock.setTimeout}.
   */
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}

/**
 * Production `Clock` implementation backed by native platform time.
 *
 * This is the default clock used by Resili clients unless callers inject a test
 * clock through the builder. It is frozen so shared clients cannot accidentally
 * mutate timing behavior at runtime.
 *
 * @public
 */
export const systemClock: Clock = Object.freeze({
  now(): number {
    return Date.now();
  },

  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> {
    return globalThis.setTimeout(callback, ms);
  },

  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
    globalThis.clearTimeout(handle);
  },
});
