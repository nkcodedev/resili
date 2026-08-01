import type { ResiliErrorCode } from "../errors";

/**
 * Stable event names emitted by Resili policies and clients.
 *
 * @public
 */
export type ResiliEventType =
  | "RequestStarted"
  | "RequestCompleted"
  | "RetryStarted"
  | "RetryCompleted"
  | "RetryFailed"
  | "CircuitOpened"
  | "CircuitHalfOpened"
  | "CircuitClosed"
  | "TimeoutTriggered"
  | "DedupeMiss"
  | "DedupeJoined"
  | "DedupeCompleted"
  | "DedupeFailed"
  | "DedupeCallerAborted"
  | "DedupeSharedAborted"
  | "HedgeScheduled"
  | "HedgeStarted"
  | "HedgeCompleted"
  | "HedgeFailed"
  | "HedgeAborted"
  | "HedgeSkipped"
  | "BulkheadRejected"
  | "RateLimited";

/**
 * Common immutable fields present on every Resili event.
 *
 * @public
 */
export interface ResiliEventBase {
  /**
   * Discriminant identifying the concrete event payload.
   */
  readonly type: ResiliEventType;

  /**
   * Epoch millisecond timestamp.
   */
  readonly timestamp: number;

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
}

/**
 * Discriminated map of every supported Resili event payload.
 *
 * @public
 */
export interface ResiliEventMap {
  /**
   * Root context has been created and execution is about to begin.
   */
  readonly RequestStarted: ResiliEventBase & {
    readonly type: "RequestStarted";
    readonly deadline: number;
  };

  /**
   * Pipeline execution settled with success or terminal error.
   */
  readonly RequestCompleted: ResiliEventBase & {
    readonly type: "RequestCompleted";
    readonly durationMs: number;
    readonly status: "success" | "error";
    readonly attempts: number;
    readonly errorCode?: ResiliErrorCode;
  };

  /**
   * Retry policy is about to perform a retry attempt.
   */
  readonly RetryStarted: ResiliEventBase & {
    readonly type: "RetryStarted";
    readonly attemptNumber: number;
    readonly delayMs: number;
    readonly reason?: ResiliErrorCode;
  };

  /**
   * A retried operation ultimately succeeded.
   */
  readonly RetryCompleted: ResiliEventBase & {
    readonly type: "RetryCompleted";
    readonly attempts: number;
    readonly totalDelayMs: number;
  };

  /**
   * Retry attempts or retry budget were exhausted.
   */
  readonly RetryFailed: ResiliEventBase & {
    readonly type: "RetryFailed";
    readonly attempts: number;
    readonly lastErrorCode?: ResiliErrorCode;
  };

  /**
   * Circuit breaker transitioned to open.
   */
  readonly CircuitOpened: ResiliEventBase & {
    readonly type: "CircuitOpened";
    readonly key: string;
    readonly failureRate: number;
    readonly resetAt: number;
  };

  /**
   * Circuit breaker transitioned to half-open.
   */
  readonly CircuitHalfOpened: ResiliEventBase & {
    readonly type: "CircuitHalfOpened";
    readonly key: string;
    readonly probesAllowed: number;
  };

  /**
   * Circuit breaker transitioned to closed.
   */
  readonly CircuitClosed: ResiliEventBase & {
    readonly type: "CircuitClosed";
    readonly key: string;
  };

  /**
   * Per-attempt timeout fired.
   */
  readonly TimeoutTriggered: ResiliEventBase & {
    readonly type: "TimeoutTriggered";
    readonly attemptNumber: number;
    readonly timeoutMs: number;
  };

  /**
   * Request deduplication created a new in-flight shared execution.
   */
  readonly DedupeMiss: ResiliEventBase & {
    readonly type: "DedupeMiss";
    readonly role: "owner";
    readonly activeCallers: number;
    readonly createdAt: number;
    readonly keyType: "string" | "number" | "symbol";
  };

  /**
   * Request deduplication joined an existing in-flight shared execution.
   */
  readonly DedupeJoined: ResiliEventBase & {
    readonly type: "DedupeJoined";
    readonly role: "joiner";
    readonly activeCallers: number;
    readonly sharedAgeMs: number;
    readonly keyType: "string" | "number" | "symbol";
  };

  /**
   * Request deduplication shared execution completed successfully.
   */
  readonly DedupeCompleted: ResiliEventBase & {
    readonly type: "DedupeCompleted";
    readonly activeCallersAtCompletion: number;
    readonly totalCallers: number;
    readonly joinedCallers: number;
    readonly durationMs: number;
    readonly sharedAborted: false;
  };

  /**
   * Request deduplication shared execution failed.
   */
  readonly DedupeFailed: ResiliEventBase & {
    readonly type: "DedupeFailed";
    readonly activeCallersAtFailure: number;
    readonly totalCallers: number;
    readonly joinedCallers: number;
    readonly durationMs: number;
    readonly lastErrorCode?: ResiliErrorCode;
  };

  /**
   * One logical request deduplication caller aborted while waiting.
   */
  readonly DedupeCallerAborted: ResiliEventBase & {
    readonly type: "DedupeCallerAborted";
    readonly role: "owner" | "joiner";
    readonly activeCallersAfterDetach: number;
    readonly sharedStillRunning: boolean;
    readonly reasonCode?: ResiliErrorCode;
  };

  /**
   * Request deduplication aborted shared work after every active caller detached.
   */
  readonly DedupeSharedAborted: ResiliEventBase & {
    readonly type: "DedupeSharedAborted";
    readonly totalCallers: number;
    readonly joinedCallers: number;
    readonly durationMs: number;
    readonly reason: "unused";
  };

  /**
   * Hedged request duplicate attempt timer was scheduled.
   */
  readonly HedgeScheduled: ResiliEventBase & {
    readonly type: "HedgeScheduled";
    readonly attemptNumber: number;
    readonly hedgeAttempt: 2;
    readonly delayMs: number;
    readonly scheduledAt: number;
  };

  /**
   * Hedged request duplicate attempt started.
   */
  readonly HedgeStarted: ResiliEventBase & {
    readonly type: "HedgeStarted";
    readonly attemptNumber: number;
    readonly hedgeAttempt: 2;
    readonly delayMs: number;
    readonly startedAt: number;
  };

  /**
   * Hedged request policy completed with an acceptable result.
   */
  readonly HedgeCompleted: ResiliEventBase & {
    readonly type: "HedgeCompleted";
    readonly attemptNumber: number;
    readonly winningHedgeAttempt: 1 | 2;
    readonly hedged: boolean;
    readonly startedAttempts: 1 | 2;
    readonly durationMs: number;
    readonly losersAborted: boolean;
  };

  /**
   * Hedged request policy failed without an acceptable result.
   */
  readonly HedgeFailed: ResiliEventBase & {
    readonly type: "HedgeFailed";
    readonly attemptNumber: number;
    readonly startedAttempts: 1 | 2;
    readonly hedged: boolean;
    readonly durationMs: number;
    readonly lastErrorCode?: ResiliErrorCode;
  };

  /**
   * Hedged request policy was terminated by parent cancellation.
   */
  readonly HedgeAborted: ResiliEventBase & {
    readonly type: "HedgeAborted";
    readonly attemptNumber: number;
    readonly startedAttempts: 0 | 1 | 2;
    readonly hedgeStarted: boolean;
    readonly durationMs: number;
    readonly reasonCode?: ResiliErrorCode;
  };

  /**
   * Hedged request duplicate attempt was intentionally not scheduled.
   */
  readonly HedgeSkipped: ResiliEventBase & {
    readonly type: "HedgeSkipped";
    readonly attemptNumber: number;
    readonly reason: "deadline";
    readonly delayMs: number;
    readonly remainingMs?: number;
  };

  /**
   * Bulkhead rejected a request due to concurrency or queue saturation.
   */
  readonly BulkheadRejected: ResiliEventBase & {
    readonly type: "BulkheadRejected";
    readonly key: string;
    readonly maxConcurrent: number;
    readonly queueSize: number;
    readonly waitedMs: number;
  };

  /**
   * Rate limiter rejected or delayed a request.
   */
  readonly RateLimited: ResiliEventBase & {
    readonly type: "RateLimited";
    readonly key: string;
    readonly strategy: string;
    readonly retryAfterMs: number;
    readonly waited: boolean;
  };
}

/**
 * Union of all supported Resili events.
 *
 * @public
 */
export type ResiliEvent = ResiliEventMap[ResiliEventType];

/**
 * Strongly typed event listener callback.
 *
 * Listener exceptions are isolated by the event bus and never propagate to the
 * publisher.
 *
 * @public
 */
export type EventHandler<T extends ResiliEventType> = (event: ResiliEventMap[T]) => void;

/**
 * Idempotent function that removes an event subscription.
 *
 * @public
 */
export type Unsubscribe = () => void;

/**
 * Internal synchronous event bus used by Resili clients and policies.
 *
 * Dispatch is synchronous. For a single emitted event, type-specific listeners
 * run in subscription order, followed by `onAny` listeners in subscription
 * order. Listener failures are caught and routed to the optional failure
 * handler.
 */
export interface EventBus {
  /**
   * Synchronously publishes an immutable event to matching listeners.
   */
  emit(event: ResiliEvent): void;

  /**
   * Subscribes to a specific event type.
   */
  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe;

  /**
   * Subscribes to every event type.
   */
  onAny(handler: (event: ResiliEvent) => void): Unsubscribe;
}

type AnyEventHandler = (event: ResiliEvent) => void;
type ListenerFailureHandler = (error: unknown, event: ResiliEvent) => void;

/**
 * Default internal `EventBus` implementation.
 *
 * The bus keeps O(1) listener lookup by event type and isolates listener
 * failures so observability code cannot break policy execution.
 */
export class DefaultEventBus implements EventBus {
  readonly #listeners = new Map<ResiliEventType, Set<AnyEventHandler>>();
  readonly #anyListeners = new Set<AnyEventHandler>();
  readonly #onListenerError: ListenerFailureHandler;

  constructor(onListenerError: ListenerFailureHandler = noopListenerFailureHandler) {
    this.#onListenerError = onListenerError;
  }

  emit(event: ResiliEvent): void {
    const immutableEvent = Object.freeze(event);
    const typedListeners = this.#listeners.get(immutableEvent.type);

    if (typedListeners !== undefined) {
      this.#dispatch(typedListeners, immutableEvent);
    }

    if (this.#anyListeners.size > 0) {
      this.#dispatch(this.#anyListeners, immutableEvent);
    }
  }

  on<T extends ResiliEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    let listeners = this.#listeners.get(type);

    if (listeners === undefined) {
      listeners = new Set<AnyEventHandler>();
      this.#listeners.set(type, listeners);
    }

    listeners.add(handler as AnyEventHandler);

    return createUnsubscribe(() => {
      listeners.delete(handler as AnyEventHandler);

      if (listeners.size === 0) {
        this.#listeners.delete(type);
      }
    });
  }

  onAny(handler: AnyEventHandler): Unsubscribe {
    this.#anyListeners.add(handler);

    return createUnsubscribe(() => {
      this.#anyListeners.delete(handler);
    });
  }

  /**
   * Removes every listener.
   *
   * This method is internal lifecycle support for future client disposal.
   */
  clear(): void {
    this.#listeners.clear();
    this.#anyListeners.clear();
  }

  #dispatch(listeners: ReadonlySet<AnyEventHandler>, event: ResiliEvent): void {
    const snapshot = Array.from(listeners);

    for (const listener of snapshot) {
      if (!listeners.has(listener)) {
        continue;
      }

      try {
        listener(event);
      } catch (error) {
        this.#onListenerError(error, event);
      }
    }
  }
}

function createUnsubscribe(remove: () => void): Unsubscribe {
  let active = true;

  return () => {
    if (!active) {
      return;
    }

    active = false;
    remove();
  };
}

function noopListenerFailureHandler(): void {
  // Listener failures are intentionally isolated by default.
}
