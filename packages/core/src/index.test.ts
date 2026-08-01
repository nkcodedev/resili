import { describe, expect, it, vi } from "vitest";

import {
  AbortError,
  BulkheadRejectedError,
  CircuitOpenError,
  ConfigurationError,
  RateLimitExceededError,
  ResiliError,
  RetryExceededError,
  TimeoutError,
  bulkheadPolicy,
  circuitBreakerPolicy,
  composeClassifier,
  createClient,
  dedupePolicy,
  definePlugin,
  fallbackPolicy,
  hedgePolicy,
  httpClassifier,
  isResiliError,
  memoryStore,
  definePolicy,
  rateLimiterPolicy,
  resili,
  retryPolicy,
  RESILI_VERSION,
  systemClock,
  timeoutPolicy,
  type Builder,
  type BulkheadOptions,
  type CircuitBreakerOptions,
  type Client,
  type ClientHealth,
  type ClientStats,
  type FailureClassifier,
  type FailureVerdict,
  type Context,
  type DedupeKey,
  type DedupeOptions,
  type FallbackOptions,
  type HedgeOptions,
  type Outcome,
  type Operation,
  type Policy,
  type PolicyFactory,
  type PolicyServices,
  type PolicyState,
  type RateLimiterOptions,
  type ResiliEventMap,
  type ResiliEventType,
  type ResiliConfig,
  type ResiliPlugin,
  type RetryOptions,
  type StateStore,
  type TimeoutOptions,
} from "./index";

describe("@resili/core package entry", () => {
  it("exposes the package version placeholder", () => {
    expect(RESILI_VERSION).toBe("0.0.0");
  });

  it("exposes the state store contract", async () => {
    const store: StateStore = memoryStore();
    const state: PolicyState = { value: 1 };

    await Promise.resolve(store.set("key", state));

    await expect(Promise.resolve(store.get("key"))).resolves.toEqual(state);
  });

  it("exposes the classification contract", () => {
    const classifier: FailureClassifier = composeClassifier(httpClassifier, {});
    const context: Pick<Context, "operationName"> = { operationName: "operation" };
    const outcome: Outcome = { status: "success", value: { status: 200 }, durationMs: 1 };
    const verdict: FailureVerdict = {
      failure: false,
      retryable: false,
    };

    expect(classifier).toBeDefined();
    expect(context.operationName).toBe("operation");
    expect(outcome.status).toBe("success");
    expect(verdict).toEqual({ failure: false, retryable: false });
  });

  it("exposes the policy contract", () => {
    const factory: PolicyFactory = definePolicy({
      name: "root-policy",
      order: 100,
      create() {
        const policy: Policy = {
          name: "root-policy",
          order: 100,
          execute(_ctx, next) {
            return next(_ctx);
          },
        };

        return policy;
      },
    });
    const services = {} as PolicyServices;

    expect(factory.name).toBe("root-policy");
    expect(typeof factory.create(services).execute).toBe("function");
  });

  it("exposes the client contract", () => {
    const stats: ClientStats = {
      circuit: {},
      bulkhead: {},
      rateLimiter: {},
      totals: { calls: 0, successes: 0, failures: 0, retries: 0 },
    };
    const health: ClientHealth = {
      status: "healthy",
      openCircuits: [],
      details: stats,
    };
    const client: Pick<Client<readonly [string], string>, "stats" | "health"> = {
      stats: () => stats,
      health: () => health,
    };

    expect(client.stats()).toBe(stats);
    expect(client.health()).toBe(health);
  });

  it("exposes public error classes and guard", () => {
    const errors = [
      new ConfigurationError("invalid"),
      new TimeoutError({ timeoutMs: 1 }),
      new CircuitOpenError({ key: "service", retryAfterMs: 1 }),
      new RetryExceededError({ attempts: 1, lastError: new Error("failed") }),
      new BulkheadRejectedError({ maxConcurrent: 1, queueSize: 0 }),
      new RateLimitExceededError({ retryAfterMs: 1 }),
      new AbortError(),
    ];

    expect(errors.every((error) => error instanceof ResiliError)).toBe(true);
    expect(errors.every((error) => isResiliError(error))).toBe(true);
  });

  it("exposes hedge events through the public event types", () => {
    const type: ResiliEventType = "HedgeCompleted";
    const event: ResiliEventMap["HedgeCompleted"] = {
      type,
      timestamp: 1,
      requestId: "request",
      operationName: "operation",
      serviceName: "service",
      attemptNumber: 1,
      winningHedgeAttempt: 2,
      hedged: true,
      startedAttempts: 2,
      durationMs: 10,
      losersAborted: true,
    };

    expect(event.type).toBe("HedgeCompleted");
  });

  it("exposes plugin contracts", () => {
    const plugin: ResiliPlugin = definePlugin({
      name: "test-plugin",
      version: "1.0.0",
      apiVersion: "1.0.0",
      setup() {
        return undefined;
      },
    });

    expect(plugin.name).toBe("test-plugin");
  });

  it("exposes built-in policy factories and option types", () => {
    const timeout: TimeoutOptions = { perAttemptMs: 10 };
    const bulkhead: BulkheadOptions = { maxConcurrent: 1 };
    const rateLimiter: RateLimiterOptions = { limit: 1, intervalMs: 100 };
    const circuitBreaker: CircuitBreakerOptions = { minimumThroughput: 1 };
    const retry: RetryOptions = { maxAttempts: 1, jitter: "none" };
    const dedupe: DedupeOptions<readonly [string]> = { key: (id) => id };
    const dedupeKey: DedupeKey = "user:42";
    const hedge: HedgeOptions<string> = {
      delay: 10,
      shouldAccept(value) {
        return value.length > 0;
      },
    };
    const fallback: FallbackOptions<string> = {
      handler() {
        return "fallback";
      },
    };

    expect(timeoutPolicy.name).toBe("timeout");
    expect(bulkheadPolicy.name).toBe("bulkhead");
    expect(rateLimiterPolicy.name).toBe("rate-limiter");
    expect(circuitBreakerPolicy.name).toBe("circuit-breaker");
    expect(retryPolicy.name).toBe("retry");
    expect(dedupePolicy.name).toBe("dedupe");
    expect(hedgePolicy.name).toBe("hedge");
    expect(fallbackPolicy.name).toBe("fallback");
    expect({
      timeout,
      bulkhead,
      rateLimiter,
      circuitBreaker,
      retry,
      dedupe,
      dedupeKey,
      hedge,
      fallback,
    }).toBeDefined();
  });

  it("creates a fluent builder with resili", async () => {
    const operation: Operation<readonly [string], string> = (id) => Promise.resolve(`user:${id}`);
    const builder: Builder<readonly [string], string> = resili(operation);
    const client = builder.build();

    await expect(client.call("42")).resolves.toBe("user:42");
  });

  it("creates a client from supported declarative config", async () => {
    const config: ResiliConfig<string> = {
      timeout: { perAttemptMs: 100 },
      dedupe: { key: () => "key" },
      hedge: { delay: 10 },
      bulkhead: { maxConcurrent: 1 },
      rateLimiter: { limit: 2, intervalMs: 100 },
      circuitBreaker: { minimumThroughput: 1 },
      retry: { maxAttempts: 1, jitter: "none" },
      fallback: {
        handler() {
          return "fallback";
        },
      },
      classifier: httpClassifier,
      store: memoryStore(),
      clock: systemClock,
      policies: [],
    };
    const client = createClient(() => Promise.resolve("ok"), config);

    await expect(client.call()).resolves.toBe("ok");
  });

  it("applies fallback config through createClient", async () => {
    const client = createClient(() => Promise.reject(new Error("failed")), {
      fallback() {
        return "fallback";
      },
    });

    await expect(client.call()).resolves.toBe("fallback");
  });

  it("accepts hedge config through createClient", async () => {
    const client = createClient(() => Promise.resolve("ok"), {
      hedge: {
        delay: 0,
      },
    });

    await expect(client.call()).resolves.toBe("ok");
  });

  it("accepts dedupe config through createClient and passes operation args to key", async () => {
    const key = vi.fn((id: string) => id);
    const gate = createGate<string>();
    const operation = vi.fn((id: string) => {
      void id;

      return gate.promise;
    });
    const client = createClient(operation, {
      dedupe: { key },
    });
    const first = client.call("42");
    const second = client.call("42");

    await flushMicrotasks();
    expect(key).toHaveBeenCalledTimes(2);
    expect(key).toHaveBeenCalledWith("42");
    expect(operation).toHaveBeenCalledTimes(1);

    gate.resolve("user:42");
    await expect(first).resolves.toBe("user:42");
    await expect(second).resolves.toBe("user:42");
  });

  it("applies custom policy config through createClient", async () => {
    const events: string[] = [];
    const factory = definePolicy({
      name: "observer",
      order: 100,
      create() {
        return {
          name: "observer",
          order: 100,
          async execute(ctx, next) {
            events.push(ctx.operationName);

            return await next(ctx);
          },
        };
      },
    });
    const client = createClient(() => Promise.resolve("ok"), {
      policies: [{ factory }],
    });

    await expect(client.call()).resolves.toBe("ok");
    expect(events).toEqual(["operation"]);
  });

  it("rejects unsupported runtime config fields", () => {
    expect(() =>
      createClient(() => Promise.resolve("ok"), {
        plugins: [],
      } as unknown as ResiliConfig),
    ).toThrow(ConfigurationError);
    expect(() =>
      createClient(() => Promise.resolve("ok"), null as unknown as ResiliConfig),
    ).toThrow(ConfigurationError);
  });
});

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
