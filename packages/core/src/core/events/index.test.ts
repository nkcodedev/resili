import { describe, expect, it, vi } from "vitest";

import { DefaultEventBus, type ResiliEvent, type ResiliEventMap, type Unsubscribe } from "./index";

const requestStartedEvent: ResiliEvent = {
  type: "RequestStarted",
  timestamp: 1_000,
  requestId: "req-1",
  operationName: "getUser",
  serviceName: "users",
  deadline: 2_000,
};

const requestCompletedEvent: ResiliEvent = {
  type: "RequestCompleted",
  timestamp: 1_100,
  requestId: "req-1",
  operationName: "getUser",
  serviceName: "users",
  durationMs: 100,
  status: "success",
  attempts: 1,
};

const hedgeStartedEvent: ResiliEvent = {
  type: "HedgeStarted",
  timestamp: 1_050,
  requestId: "req-1",
  operationName: "getUser",
  serviceName: "users",
  attemptNumber: 1,
  hedgeAttempt: 2,
  delayMs: 50,
  startedAt: 1_050,
};

describe("DefaultEventBus", () => {
  it("publishes events to type-specific listeners synchronously", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();

    bus.on("RequestStarted", listener);
    bus.emit(requestStartedEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(requestStartedEvent);
  });

  it("does nothing when no listeners match", () => {
    const bus = new DefaultEventBus();

    expect(() => {
      bus.emit(requestStartedEvent);
    }).not.toThrow();
  });

  it("does not publish to listeners for other event types", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();

    bus.on("RequestCompleted", listener);
    bus.emit(requestStartedEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports typed hedge event subscriptions", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn((event: ResiliEventMap["HedgeStarted"]) => {
      expect(event.hedgeAttempt).toBe(2);
      expect(event.delayMs).toBe(50);
    });

    bus.on("HedgeStarted", listener);
    bus.emit(hedgeStartedEvent);

    expect(listener).toHaveBeenCalledWith(hedgeStartedEvent);
  });

  it("publishes to onAny listeners after type-specific listeners", () => {
    const bus = new DefaultEventBus();
    const calls: string[] = [];

    bus.onAny(() => {
      calls.push("any-1");
    });
    bus.on("RequestStarted", () => {
      calls.push("typed-1");
    });
    bus.onAny(() => {
      calls.push("any-2");
    });
    bus.on("RequestStarted", () => {
      calls.push("typed-2");
    });

    bus.emit(requestStartedEvent);

    expect(calls).toEqual(["typed-1", "typed-2", "any-1", "any-2"]);
  });

  it("preserves FIFO ordering within listener groups", () => {
    const bus = new DefaultEventBus();
    const calls: number[] = [];

    bus.on("RequestStarted", () => {
      calls.push(1);
    });
    bus.on("RequestStarted", () => {
      calls.push(2);
    });
    bus.on("RequestStarted", () => {
      calls.push(3);
    });

    bus.emit(requestStartedEvent);

    expect(calls).toEqual([1, 2, 3]);
  });

  it("isolates listener failures and continues dispatching", () => {
    const listenerError = new Error("listener failed");
    const onListenerError = vi.fn();
    const bus = new DefaultEventBus(onListenerError);
    const afterFailure = vi.fn();

    bus.on("RequestStarted", () => {
      throw listenerError;
    });
    bus.on("RequestStarted", afterFailure);

    expect(() => {
      bus.emit(requestStartedEvent);
    }).not.toThrow();

    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(listenerError, requestStartedEvent);
    expect(afterFailure).toHaveBeenCalledTimes(1);
  });

  it("isolates listener failures with the default failure handler", () => {
    const bus = new DefaultEventBus();

    bus.on("RequestStarted", () => {
      throw new Error("listener failed");
    });

    expect(() => {
      bus.emit(requestStartedEvent);
    }).not.toThrow();
  });

  it("freezes published events so listeners cannot mutate payloads", () => {
    const bus = new DefaultEventBus();

    bus.on("RequestStarted", (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(() => {
        (event as { deadline: number }).deadline = 3_000;
      }).toThrow(TypeError);
    });

    bus.emit({ ...requestStartedEvent });
  });

  it("unsubscribes type-specific listeners", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.on("RequestStarted", listener);

    unsubscribe();
    bus.emit(requestStartedEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports idempotent unsubscription", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.on("RequestStarted", listener);

    unsubscribe();
    unsubscribe();
    bus.emit(requestStartedEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it("deduplicates repeated handler subscriptions for the same event type", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();

    bus.on("RequestStarted", listener);
    bus.on("RequestStarted", listener);
    bus.emit(requestStartedEvent);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes onAny listeners", () => {
    const bus = new DefaultEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.onAny(listener);

    unsubscribe();
    bus.emit(requestStartedEvent);

    expect(listener).not.toHaveBeenCalled();
  });

  it("clears all listeners", () => {
    const bus = new DefaultEventBus();
    const typedListener = vi.fn();
    const anyListener = vi.fn();

    bus.on("RequestStarted", typedListener);
    bus.onAny(anyListener);
    bus.clear();

    bus.emit(requestStartedEvent);

    expect(typedListener).not.toHaveBeenCalled();
    expect(anyListener).not.toHaveBeenCalled();
  });

  it("supports nested event publication depth-first", () => {
    const bus = new DefaultEventBus();
    const calls: string[] = [];

    bus.on("RequestStarted", () => {
      calls.push("started-1");
      bus.emit(requestCompletedEvent);
      calls.push("started-2");
    });
    bus.on("RequestCompleted", () => {
      calls.push("completed");
    });

    bus.emit(requestStartedEvent);

    expect(calls).toEqual(["started-1", "completed", "started-2"]);
  });

  it("does not call a listener removed before its turn in the same dispatch", () => {
    const bus = new DefaultEventBus();
    const removed = vi.fn();
    const removers: Unsubscribe[] = [];

    bus.on("RequestStarted", () => {
      removers[0]?.();
    });
    removers.push(bus.on("RequestStarted", removed));

    bus.emit(requestStartedEvent);

    expect(removed).not.toHaveBeenCalled();
  });

  it("does not call a listener added during the current dispatch", () => {
    const bus = new DefaultEventBus();
    const added = vi.fn();

    bus.on("RequestStarted", () => {
      bus.on("RequestStarted", added);
    });

    bus.emit(requestStartedEvent);
    expect(added).not.toHaveBeenCalled();

    bus.emit(requestStartedEvent);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it("handles async publishers without shared execution state", async () => {
    const bus = new DefaultEventBus();
    const calls: string[] = [];

    bus.onAny((event) => {
      calls.push(event.requestId);
    });

    await Promise.all([
      Promise.resolve().then(() => {
        bus.emit({ ...requestStartedEvent, requestId: "req-1" });
      }),
      Promise.resolve().then(() => {
        bus.emit({ ...requestStartedEvent, requestId: "req-2" });
      }),
    ]);

    expect(calls.sort()).toEqual(["req-1", "req-2"]);
  });
});
