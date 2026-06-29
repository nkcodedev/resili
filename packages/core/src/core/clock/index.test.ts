import { afterEach, describe, expect, it, vi } from "vitest";

import { systemClock, type Clock } from "./index";

afterEach(() => {
  vi.useRealTimers();
});

describe("systemClock", () => {
  it("returns current epoch milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_234);

    expect(systemClock.now()).toBe(1_234);
  });

  it("schedules callbacks with native timers", () => {
    vi.useFakeTimers();
    const callback = vi.fn();

    systemClock.setTimeout(callback, 50);

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(49);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("clears scheduled timers", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const handle = systemClock.setTimeout(callback, 50);

    systemClock.clearTimeout(handle);
    vi.advanceTimersByTime(50);

    expect(callback).not.toHaveBeenCalled();
  });

  it("is immutable", () => {
    expect(Object.isFrozen(systemClock)).toBe(true);
    expect(() => {
      (systemClock as { now: () => number }).now = () => 0;
    }).toThrow(TypeError);
  });
});

describe("Clock contract", () => {
  it("supports deterministic fake implementations without public fake-clock APIs", () => {
    const fakeClock = new TestClock(1_000);
    const callback = vi.fn();

    const handle = fakeClock.setTimeout(callback, 100);

    expect(fakeClock.now()).toBe(1_000);
    fakeClock.tick(99);
    expect(callback).not.toHaveBeenCalled();

    fakeClock.tick(1);
    expect(callback).toHaveBeenCalledTimes(1);

    fakeClock.clearTimeout(handle);
    expect(fakeClock.pendingTimers()).toBe(0);
  });

  it("supports deterministic timer cancellation", () => {
    const fakeClock = new TestClock(0);
    const callback = vi.fn();
    const handle = fakeClock.setTimeout(callback, 10);

    fakeClock.clearTimeout(handle);
    fakeClock.tick(10);

    expect(callback).not.toHaveBeenCalled();
    expect(fakeClock.pendingTimers()).toBe(0);
  });

  it("executes timers scheduled by callbacks deterministically", () => {
    const fakeClock = new TestClock(0);
    const calls: string[] = [];

    fakeClock.setTimeout(() => {
      calls.push("first");
      fakeClock.setTimeout(() => {
        calls.push("nested");
      }, 5);
    }, 10);

    fakeClock.tick(10);
    expect(calls).toEqual(["first"]);

    fakeClock.tick(5);
    expect(calls).toEqual(["first", "nested"]);
  });

  it("executes concurrent timers in deadline order", () => {
    const fakeClock = new TestClock(0);
    const calls: string[] = [];

    fakeClock.setTimeout(() => {
      calls.push("late");
    }, 20);
    fakeClock.setTimeout(() => {
      calls.push("early");
    }, 10);
    fakeClock.setTimeout(() => {
      calls.push("same-time");
    }, 10);

    fakeClock.tick(20);

    expect(calls).toEqual(["early", "same-time", "late"]);
  });
});

interface TestTimer {
  readonly id: number;
  readonly deadline: number;
  readonly callback: () => void;
}

class TestClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, TestTimer>();

  constructor(now: number) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, {
      id,
      deadline: this.#now + ms,
      callback,
    });

    return id;
  }

  clearTimeout(handle: number): void {
    this.#timers.delete(handle);
  }

  tick(ms: number): void {
    const target = this.#now + ms;
    let next = this.#nextDueTimer(target);

    while (next !== undefined) {
      this.#timers.delete(next.id);
      this.#now = next.deadline;
      next.callback();
      next = this.#nextDueTimer(target);
    }

    this.#now = target;
  }

  pendingTimers(): number {
    return this.#timers.size;
  }

  #nextDueTimer(target: number): TestTimer | undefined {
    let next: TestTimer | undefined;

    for (const timer of this.#timers.values()) {
      if (timer.deadline > target) {
        continue;
      }

      if (
        next === undefined ||
        timer.deadline < next.deadline ||
        (timer.deadline === next.deadline && timer.id < next.id)
      ) {
        next = timer;
      }
    }

    return next;
  }
}
