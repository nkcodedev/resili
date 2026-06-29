import { afterEach, describe, expect, it, vi } from "vitest";

import { createContext, releaseContext, type ContextInit } from "./context";

afterEach(() => {
  vi.useRealTimers();
});

describe("createContext", () => {
  it("creates an immutable root context with defaults", () => {
    const ctx = createContext();

    expect(ctx.requestId).toEqual(expect.any(String));
    expect(ctx.requestId).not.toHaveLength(0);
    expect(ctx.operationName).toBe("operation");
    expect(ctx.serviceName).toBe("default");
    expect(ctx.attemptNumber).toBe(1);
    expect(ctx.deadline).toBe(Number.POSITIVE_INFINITY);
    expect(ctx.startedAt).toEqual(expect.any(Number));
    expect(ctx.metadata.size).toBe(0);
    expect(ctx.signal.aborted).toBe(false);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("uses explicit context values", () => {
    const signal = new AbortController().signal;
    const ctx = createContext({
      requestId: "req-1",
      operationName: "getUser",
      serviceName: "users",
      attemptNumber: 3,
      metadata: { tenant: "acme" },
      signal,
      startedAt: 1_000,
      deadline: 2_000,
    });

    expect(ctx.requestId).toBe("req-1");
    expect(ctx.operationName).toBe("getUser");
    expect(ctx.serviceName).toBe("users");
    expect(ctx.attemptNumber).toBe(3);
    expect(ctx.metadata.get("tenant")).toBe("acme");
    expect(ctx.startedAt).toBe(1_000);
    expect(ctx.deadline).toBe(2_000);
  });

  it("calculates an absolute deadline from deadlineMs", () => {
    const ctx = createContext({ startedAt: 1_000, deadlineMs: 250 });

    expect(ctx.deadline).toBe(1_250);
  });

  it("prefers an explicit deadline over deadlineMs", () => {
    const ctx = createContext({ startedAt: 1_000, deadline: 5_000, deadlineMs: 250 });

    expect(ctx.deadline).toBe(5_000);
  });

  it("creates readonly metadata from records", () => {
    const source = { tenant: "acme", idempotent: true };
    const ctx = createContext({ metadata: source });

    source.tenant = "changed";

    expect(ctx.metadata.size).toBe(2);
    expect(ctx.metadata.get("tenant")).toBe("acme");
    expect(ctx.metadata.get("idempotent")).toBe(true);
    expect([...ctx.metadata.keys()]).toEqual(["tenant", "idempotent"]);
    expect([...ctx.metadata.values()]).toEqual(["acme", true]);
    expect([...ctx.metadata.entries()]).toEqual([
      ["tenant", "acme"],
      ["idempotent", true],
    ]);
    expect([...ctx.metadata]).toEqual([
      ["tenant", "acme"],
      ["idempotent", true],
    ]);
    expect("size" in ctx.metadata).toBe(true);
    expect("unknown" in ctx.metadata).toBe(false);
    expect("set" in ctx.metadata).toBe(false);
    expect((ctx.metadata as unknown as { readonly set?: unknown }).set).toBeUndefined();
  });

  it("blocks runtime metadata mutation attempts", () => {
    const ctx = createContext({ metadata: { tenant: "acme" } });

    expect(() => {
      (ctx.metadata as unknown as { tenant: string }).tenant = "globex";
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(ctx.metadata, "tenant", { value: "globex" });
    }).toThrow(TypeError);
    expect(() => {
      delete (ctx.metadata as unknown as { tenant?: string }).tenant;
    }).toThrow(TypeError);
    expect(ctx.metadata.get("tenant")).toBe("acme");
  });

  it("creates readonly metadata from maps", () => {
    const source = new Map<string, unknown>([["tenant", "acme"]]);
    const ctx = createContext({ metadata: source });

    source.set("tenant", "changed");

    expect(ctx.metadata.get("tenant")).toBe("acme");
    expect(ctx.metadata.has("tenant")).toBe(true);
  });

  it("supports metadata forEach with thisArg", () => {
    const ctx = createContext({ metadata: { tenant: "acme" } });
    const seen: [string, unknown, boolean][] = [];
    const thisArg = { marker: true };

    ctx.metadata.forEach(function collect(value, key, map) {
      seen.push([key, value, this === thisArg && map === ctx.metadata]);
    }, thisArg);

    expect(seen).toEqual([["tenant", "acme", true]]);
  });

  it("returns an immutable context snapshot", () => {
    const snapshot = createContext({
      requestId: "req-1",
      operationName: "getUser",
      serviceName: "users",
      attemptNumber: 2,
    }).snapshot();

    expect(snapshot).toEqual({
      requestId: "req-1",
      operationName: "getUser",
      serviceName: "users",
      attemptNumber: 2,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("Context.fork", () => {
  it("creates a new child context without mutating the parent", () => {
    const parent = createContext({
      requestId: "req-1",
      operationName: "getUser",
      serviceName: "users",
      metadata: { tenant: "acme" },
      startedAt: 1_000,
      deadline: 2_000,
    });

    const child = parent.fork({ metadata: { attempt: "retry" } });

    expect(child).not.toBe(parent);
    expect(child.requestId).toBe(parent.requestId);
    expect(child.operationName).toBe(parent.operationName);
    expect(child.serviceName).toBe(parent.serviceName);
    expect(child.startedAt).toBe(parent.startedAt);
    expect(child.deadline).toBe(parent.deadline);
    expect(child.attemptNumber).toBe(2);
    expect(child.metadata.get("tenant")).toBe("acme");
    expect(child.metadata.get("attempt")).toBe("retry");
    expect(parent.attemptNumber).toBe(1);
    expect(parent.metadata.has("attempt")).toBe(false);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("supports explicit child attempt numbers", () => {
    const child = createContext().fork({ attemptNumber: 5 });

    expect(child.attemptNumber).toBe(5);
  });

  it("reuses parent metadata when no metadata patch is supplied", () => {
    const parent = createContext({ metadata: { tenant: "acme" } });
    const child = parent.fork({});

    expect(child.metadata).toBe(parent.metadata);
  });

  it("lets child metadata override parent metadata", () => {
    const child = createContext({ metadata: { tenant: "acme" } }).fork({
      metadata: { tenant: "globex" },
    });

    expect(child.metadata.get("tenant")).toBe("globex");
  });

  it("supports multiple independent forks", () => {
    const parent = createContext({ requestId: "req-1" });
    const first = parent.fork({ metadata: { branch: "a" } });
    const second = parent.fork({ metadata: { branch: "b" } });

    expect(first).not.toBe(second);
    expect(first.attemptNumber).toBe(2);
    expect(second.attemptNumber).toBe(2);
    expect(first.metadata.get("branch")).toBe("a");
    expect(second.metadata.get("branch")).toBe("b");
  });

  it("supports nested forks", () => {
    const root = createContext({ metadata: { root: true } });
    const attempt2 = root.fork({ metadata: { attempt2: true } });
    const attempt3 = attempt2.fork({ metadata: { attempt3: true } });

    expect(attempt3.attemptNumber).toBe(3);
    expect(attempt3.metadata.get("root")).toBe(true);
    expect(attempt3.metadata.get("attempt2")).toBe(true);
    expect(attempt3.metadata.get("attempt3")).toBe(true);
    expect(root.metadata.has("attempt2")).toBe(false);
    expect(attempt2.metadata.has("attempt3")).toBe(false);
  });
});

describe("Context signal composition", () => {
  it("propagates caller aborts to the root context signal", () => {
    const caller = new AbortController();
    const ctx = createContext({ signal: caller.signal });

    caller.abort("caller cancelled");

    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBe("caller cancelled");
  });

  it("propagates already-aborted caller signals", () => {
    const caller = new AbortController();
    caller.abort("already cancelled");

    const ctx = createContext({ signal: caller.signal });

    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBe("already cancelled");
  });

  it("propagates parent aborts to a child context", () => {
    const caller = new AbortController();
    const child = createContext({ signal: caller.signal }).fork({});

    caller.abort("parent cancelled");

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("parent cancelled");
  });

  it("propagates attempt timeout aborts to only the child context", () => {
    const timeout = new AbortController();
    const parent = createContext();
    const child = parent.fork({ signal: timeout.signal });

    timeout.abort("attempt timed out");

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("attempt timed out");
    expect(parent.signal.aborted).toBe(false);
  });

  it("aborts when the deadline elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createContext({ deadline: 1_100 });

    expect(ctx.signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);

    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBeInstanceOf(DOMException);
    expect((ctx.signal.reason as DOMException).name).toBe("AbortError");
  });

  it("aborts immediately when the deadline has already passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createContext({ deadline: 999 });

    expect(ctx.signal.aborted).toBe(true);
  });

  it("releases pending deadline timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createContext({ deadline: 2_000 });

    expect(vi.getTimerCount()).toBe(1);

    releaseContext(ctx);

    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(ctx.signal.aborted).toBe(false);
  });

  it("removes caller abort listeners when released", () => {
    const caller = new AbortController();
    const ctx = createContext({ signal: caller.signal });

    releaseContext(ctx);
    caller.abort("caller cancelled");

    expect(ctx.signal.aborted).toBe(false);
  });

  it("allows release to be called more than once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createContext({ deadline: 2_000 });

    releaseContext(ctx);
    releaseContext(ctx);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows release after the context has already aborted", () => {
    const caller = new AbortController();
    const ctx = createContext({ signal: caller.signal });

    caller.abort("caller cancelled");
    releaseContext(ctx);

    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBe("caller cancelled");
  });

  it("does not let later aborts replace the first abort reason", () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const child = createContext({ signal: caller.signal }).fork({ signal: timeout.signal });

    timeout.abort("timeout");
    caller.abort("caller");

    expect(child.signal.reason).toBe("timeout");
  });

  it("handles duplicate abort notifications without changing state", () => {
    const caller = new AbortController();
    const parent = createContext({ signal: caller.signal });
    const child = parent.fork({ signal: caller.signal });

    caller.abort("caller");

    expect(parent.signal.reason).toBe("caller");
    expect(child.signal.reason).toBe("caller");
  });
});

describe("Context validation", () => {
  it.each([
    ["requestId", { requestId: "" }],
    ["operationName", { operationName: "   " }],
    ["serviceName", { serviceName: "" }],
  ] satisfies [string, ContextInit][])("rejects invalid %s", (_field, init) => {
    expect(() => createContext(init)).toThrow(TypeError);
  });

  it.each([
    ["attemptNumber", { attemptNumber: 0 }],
    ["attemptNumber", { attemptNumber: 1.5 }],
    ["deadline", { deadline: Number.NaN }],
    ["deadlineMs", { deadlineMs: -1 }],
    ["startedAt", { startedAt: Number.POSITIVE_INFINITY }],
  ] satisfies [string, ContextInit][])("rejects invalid %s", (_field, init) => {
    expect(() => createContext(init)).toThrow(RangeError);
  });

  it("rejects invalid signals", () => {
    expect(() => createContext({ signal: {} as AbortSignal })).toThrow(TypeError);
    expect(() => createContext().fork({ signal: {} as AbortSignal })).toThrow(TypeError);
  });

  it("rejects invalid metadata", () => {
    expect(() => createContext({ metadata: null as unknown as ContextInit["metadata"] })).toThrow(
      TypeError,
    );
    expect(() => createContext({ metadata: [] as unknown as ContextInit["metadata"] })).toThrow(
      TypeError,
    );
    expect(() =>
      createContext({ metadata: new Map([[1, "bad"]]) as unknown as ContextInit["metadata"] }),
    ).toThrow(TypeError);
  });

  it("rejects invalid fork patches", () => {
    const ctx = createContext();

    expect(() => ctx.fork({ attemptNumber: 0 })).toThrow(RangeError);
    expect(() => ctx.fork({ metadata: null as unknown as Record<string, unknown> })).toThrow(
      TypeError,
    );
  });
});
