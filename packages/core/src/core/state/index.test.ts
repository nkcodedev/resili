import { describe, expect, it } from "vitest";

import { memoryStore, type PolicyState, type StateStore } from "./index";

describe("memoryStore", () => {
  it("creates a StateStore implementation", () => {
    const store = createSyncStore();

    expect(store.get("missing")).toBeUndefined();
  });

  it("sets and gets immutable policy state", () => {
    const store = createSyncStore();
    const original = { state: "closed", failures: 0 };

    store.set("circuit:users", original);
    original.state = "open";

    const stored = store.get("circuit:users");

    expect(stored).toEqual({ state: "closed", failures: 0 });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { state: string }).state = "open";
    }).toThrow(TypeError);
  });

  it("replaces state on set", () => {
    const store = createSyncStore();

    store.set("key", { value: 1 });
    store.set("key", { value: 2 });

    expect(store.get("key")).toEqual({ value: 2 });
  });

  it("supports typed reads", () => {
    interface CircuitState extends PolicyState {
      readonly state: "closed" | "open";
    }

    const store = createSyncStore();

    store.set("circuit", { state: "closed" });

    const state = store.get<CircuitState>("circuit");

    expect(state?.state).toBe("closed");
  });

  it("increments missing state and fields from zero", () => {
    const store = createSyncStore();

    expect(store.incr("rate:users", "tokens", 1)).toBe(1);
    expect(store.incr("rate:users", "tokens", 2)).toBe(3);
    expect(store.get("rate:users")).toEqual({ tokens: 3 });
  });

  it("preserves other fields when incrementing", () => {
    const store = createSyncStore();

    store.set("window", { failures: 1, successes: 2 });

    expect(store.incr("window", "failures", 3)).toBe(4);
    expect(store.get("window")).toEqual({ failures: 4, successes: 2 });
  });

  it("supports negative increments", () => {
    const store = createSyncStore();

    store.set("bulkhead", { active: 3 });

    expect(store.incr("bulkhead", "active", -1)).toBe(2);
  });

  it("rejects invalid keys", async () => {
    const store = createSyncStore();

    expect(() => store.get("")).toThrow(TypeError);
    expect(() => {
      store.set("   ", {});
    }).toThrow(TypeError);
    expect(() => store.incr("key", "", 1)).toThrow(TypeError);
    await awaitExpectLockError(store, "");
  });

  it("rejects invalid state", () => {
    const store = createSyncStore();

    expect(() => {
      store.set("key", null as unknown as PolicyState);
    }).toThrow(TypeError);
    expect(() => {
      store.set("key", [] as unknown as PolicyState);
    }).toThrow(TypeError);
  });

  it("rejects invalid increments", () => {
    const store = createSyncStore();

    expect(() => store.incr("key", "count", Number.NaN)).toThrow(RangeError);
    expect(() => store.incr("key", "count", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rejects incrementing non-numeric fields", () => {
    const store = createSyncStore();

    store.set("key", { count: "one" });

    expect(() => store.incr("key", "count", 1)).toThrow(TypeError);
  });

  it("runs lock callbacks and returns their values", async () => {
    const store = createSyncStore();

    const result = await store.withLock("key", () => "done");

    expect(result).toBe("done");
  });

  it("serializes concurrent access for the same key", async () => {
    const store = createSyncStore();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.withLock("same", async () => {
      order.push("first-start");
      await firstCanFinish;
      order.push("first-end");
    });
    const second = store.withLock("same", () => {
      order.push("second");
    });

    await waitForLockTurn();
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("allows different keys to run concurrently", async () => {
    const store = createSyncStore();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.withLock("a", async () => {
      order.push("a-start");
      await firstCanFinish;
      order.push("a-end");
    });
    const second = store.withLock("b", () => {
      order.push("b");
    });

    await second;
    expect(order).toEqual(["a-start", "b"]);

    releaseFirst();
    await first;

    expect(order).toEqual(["a-start", "b", "a-end"]);
  });

  it("continues lock queue after a callback throws", async () => {
    const store = createSyncStore();
    const order: string[] = [];
    const error = new Error("boom");

    const first = store.withLock("key", () => {
      order.push("first");
      throw error;
    });
    const second = store.withLock("key", () => {
      order.push("second");
      return "ok";
    });

    await expect(first).rejects.toBe(error);
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("supports atomic read-modify-write with withLock", async () => {
    const store = createSyncStore();
    store.set("counter", { value: 0 });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.withLock("counter", () => {
          const current = store.get("counter")?.value;
          const value = typeof current === "number" ? current : 0;
          store.set("counter", { value: value + 1 });
        }),
      ),
    );

    expect(store.get("counter")).toEqual({ value: 10 });
  });
});

interface SyncStateStore extends StateStore {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Mirrors the frozen StateStore contract for typed reads.
  get<S extends PolicyState>(key: string): S | undefined;
  set(key: string, state: PolicyState): void;
  incr(key: string, field: string, by: number): number;
}

function createSyncStore(): SyncStateStore {
  return memoryStore() as SyncStateStore;
}

async function waitForLockTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function awaitExpectLockError(store: StateStore, key: string): Promise<void> {
  await expect(store.withLock(key, () => undefined)).rejects.toThrow(TypeError);
}
