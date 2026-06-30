import { describe, expect, it } from "vitest";

import {
  composeClassifier,
  httpClassifier,
  memoryStore,
  definePolicy,
  RESILI_VERSION,
  type Client,
  type ClientHealth,
  type ClientStats,
  type FailureClassifier,
  type FailureVerdict,
  type Context,
  type Outcome,
  type Policy,
  type PolicyFactory,
  type PolicyServices,
  type PolicyState,
  type StateStore,
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
});
