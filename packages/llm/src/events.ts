/**
 * LLM lifecycle event names.
 *
 * Core Resili events (retry, timeout, …) remain available through
 * `LlmClient.onCore`. These names cover LLM-specific telemetry that cannot be
 * added to core's closed event map without a core change.
 *
 * @public
 */
export type LlmEventType =
  | "LlmRequestStarted"
  | "LlmRequestCompleted"
  | "LlmRequestFailed"
  | "LlmUsageRecorded"
  | "LlmBudgetWarning"
  | "LlmBudgetRejected";

/**
 * Common immutable fields on every LLM event.
 *
 * Events never include API keys, prompts, or model output.
 *
 * @public
 */
export interface LlmEventBase {
  readonly type: LlmEventType;
  readonly timestamp: number;
  readonly requestId: string;
  readonly operationName: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * Discriminated LLM event payloads.
 *
 * @public
 */
export interface LlmEventMap {
  readonly LlmRequestStarted: LlmEventBase & {
    readonly type: "LlmRequestStarted";
  };
  readonly LlmRequestCompleted: LlmEventBase & {
    readonly type: "LlmRequestCompleted";
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costMicroUsd?: number;
  };
  readonly LlmRequestFailed: LlmEventBase & {
    readonly type: "LlmRequestFailed";
    readonly durationMs: number;
    readonly classification: string;
    readonly retryable: boolean;
  };
  readonly LlmUsageRecorded: LlmEventBase & {
    readonly type: "LlmUsageRecorded";
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costMicroUsd?: number;
  };
  readonly LlmBudgetWarning: LlmEventBase & {
    readonly type: "LlmBudgetWarning";
    readonly scope: string;
    readonly accumulatedMicroUsd: number;
    readonly limitMicroUsd: number;
  };
  readonly LlmBudgetRejected: LlmEventBase & {
    readonly type: "LlmBudgetRejected";
    readonly scope: string;
    readonly limitKind: "per-request" | "accumulated" | "unknown-pricing";
    readonly accumulatedMicroUsd: number;
    readonly attemptedMicroUsd: number;
    readonly limitMicroUsd: number;
  };
}

/**
 * Union of LLM events.
 *
 * @public
 */
export type LlmEvent = LlmEventMap[LlmEventType];

/**
 * Typed LLM event listener.
 *
 * @public
 */
export type LlmEventHandler<T extends LlmEventType> = (event: LlmEventMap[T]) => void;

/**
 * Removes an event subscription.
 *
 * @public
 */
export type LlmUnsubscribe = () => void;

type AnyLlmHandler = (event: LlmEvent) => void;

/**
 * @internal
 */
export class LlmEventBus {
  readonly #listeners = new Map<LlmEventType, Set<AnyLlmHandler>>();

  emit(event: LlmEvent): void {
    const immutableEvent = Object.freeze(event);
    const listeners = this.#listeners.get(immutableEvent.type);

    if (listeners === undefined) {
      return;
    }

    const snapshot = Array.from(listeners);

    for (const listener of snapshot) {
      if (!listeners.has(listener)) {
        continue;
      }

      try {
        listener(immutableEvent);
      } catch {
        // Listener failures must not affect request execution.
      }
    }
  }

  on<T extends LlmEventType>(type: T, handler: LlmEventHandler<T>): LlmUnsubscribe {
    let listeners = this.#listeners.get(type);

    if (listeners === undefined) {
      listeners = new Set<AnyLlmHandler>();
      this.#listeners.set(type, listeners);
    }

    listeners.add(handler as AnyLlmHandler);

    return (): void => {
      listeners.delete(handler as AnyLlmHandler);

      if (listeners.size === 0) {
        this.#listeners.delete(type);
      }
    };
  }

  clear(): void {
    this.#listeners.clear();
  }
}
