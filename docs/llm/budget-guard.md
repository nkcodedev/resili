# Budget Guard

Budget Guard puts a spending limit in front of LLM calls. It estimates cost before the provider runs,
reserves it, and settles against authoritative usage afterwards.

## Lifecycle

```text
estimated cost              from estimatedInputTokens / estimatedOutputTokens + your price table
    ↓
budget preflight            reject if it would exceed a limit
    ↓
reserve estimated cost      against the accumulated cap
    ↓
LLM execution               retry, timeout, provider call
    ↓
authoritative usage         provider-reported tokens
    ↓
settle                      replace the reservation with actual cost (or 0 on failure)
```

Reservations exist to close a race: two concurrent requests must not both be admitted against the
same remaining budget. Reserving the estimate up front means the second sees the first's reservation.

## Pipeline placement

Budget Guard registers at `{ before: "retry" }`, resolving to order `199.5`:

```text
fallback → cache → llm-budget → retry → circuit-breaker → timeout → … → provider
```

Outside retry, so one reservation covers the whole logical request rather than one per attempt. The
consequence to internalize: **each retry is a real billable call, but only one estimate was
reserved.** With `maxAttempts: 3`, actual spend can be roughly three times the reservation.

## Configuration

```ts
interface BudgetGuardOptions {
  readonly maxCostPerRequestUsd?: number;
  readonly maxAccumulatedCostUsd?: number;
  readonly scope?: string | BudgetScopeResolver;
  readonly warningThresholdRatio?: number;
  readonly onUnknownPricing?: "allow" | "reject";
  readonly accountant?: BudgetAccountant;
}
```

| Option                  | Default                          | Purpose                                                       |
| ----------------------- | -------------------------------- | ------------------------------------------------------------- |
| `maxCostPerRequestUsd`  | —                                | Per-request cap on **estimated** cost                         |
| `maxAccumulatedCostUsd` | —                                | Cap on committed spend plus in-flight reservations            |
| `scope`                 | `request.provider`               | Accounting bucket; string or `(request, ctx) => string`       |
| `warningThresholdRatio` | `0.8`                            | Emit `LlmBudgetWarning` at this fraction of the cap. `(0, 1]` |
| `onUnknownPricing`      | `"reject"`                       | Behavior when the price is unknown                            |
| `accountant`            | `createMemoryBudgetAccountant()` | Ledger implementation                                         |

At least one of the two limits is required. Limits are **inclusive** — an estimate exactly at the cap
is allowed.

```ts
const llm = createLlmClient({
  provider,
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
  ]),
  budget: {
    maxCostPerRequestUsd: 0.05,
    maxAccumulatedCostUsd: 25,
    warningThresholdRatio: 0.8,
    scope: (request) => `${request.provider}:${new Date().toISOString().slice(0, 10)}`,
  },
});
```

## Estimates matter

The preflight can only work with the numbers you supply.

```ts
await llm.generate({
  input: prompt,
  estimatedInputTokens: 850,
  estimatedOutputTokens: 400,
});
```

Omit them and the estimate is **zero**, which means `maxCostPerRequestUsd` never rejects anything and
a zero reservation blocks nothing. Concurrent requests without estimates can therefore overshoot
`maxAccumulatedCostUsd` — each reserves nothing, all are admitted, and every one settles real cost
afterwards.

A rough heuristic for `estimatedInputTokens` is `input.length / 4`; for output, use your `max_tokens`
cap, which gives a conservative upper bound.

## `maxCostPerRequestUsd` is not a hard ceiling

It compares the **estimate**, before the provider runs. Output length is unknowable in advance, so
actual cost can exceed it — a request estimated at $0.01 that generates ten times the expected tokens
will complete and settle above the cap.

To bound actual per-request spend, cap output at the provider: `max_tokens` for Anthropic (required by
that adapter), or a model-level limit. That is a real ceiling; the budget check is a guard rail.

## Unknown pricing

When the resolver has no row for a provider/model pair:

| `onUnknownPricing`   | Behavior                                                                          |
| -------------------- | --------------------------------------------------------------------------------- |
| `"reject"` (default) | Fail closed. Throws `LlmBudgetExceededError` with `limitKind: "unknown-pricing"`. |
| `"allow"`            | Fail open. Skips the cost preflight and accounting for that request.              |

Failing closed is the default because the alternative — treating an unpriced model as free — silently
defeats the budget. Configuring `budget` with the default `"reject"` and no `pricing` resolver raises a
`ConfigurationError` at construction.

`"allow"` is an explicit, auditable choice for a model you are deliberately not metering.

## Settlement

| Outcome                    | Settled actual cost                             |
| -------------------------- | ----------------------------------------------- |
| Success with usage         | Cost computed from authoritative provider usage |
| Success, unknown price     | `0`                                             |
| Provider failure           | `0`                                             |
| Timeout                    | `0`                                             |
| Cancellation / early break | `0`                                             |

In every non-success case the reservation is released and nothing is committed. **Resili never invents
token counts.**

For streaming, settlement happens when the execution ends — completion, failure, abort, or `break`.

### The interrupted-stream gap

This is the limitation to be clear-eyed about.

When a stream is interrupted, providers often do not send a final usage frame. Resili settles zero,
but the provider may still bill for the tokens it generated. **Resili cannot know provider billing for
an interrupted stream when the provider does not return usage.**

If you cancel streams routinely, expect Resili's accumulated figure to under-report your actual
invoice. Treat it as a control on _intended_ spend and reconcile against provider billing for the
authoritative number.

## The accountant

```ts
interface BudgetAccountant {
  getAccumulatedMicroUsd(scope: string): number;
  getReservedMicroUsd(scope: string): number;
  reserve(scope: string, estimatedMicroUsd: number, maxAccumulatedMicroUsd?: number): boolean;
  settle(scope: string, reservedMicroUsd: number, actualMicroUsd: number): number;
}
```

The default `createMemoryBudgetAccountant()` is a process-local map. `reserve` and `settle` are
**synchronous**, which is what makes the concurrency guarantee hold: two overlapping requests cannot
both reserve the last of the budget. A custom accountant must preserve that atomicity — an async
implementation that awaits between read and write reintroduces the race it exists to prevent.

```ts
const accountant = createMemoryBudgetAccountant();

const llm = createLlmClient({
  provider,
  pricing,
  budget: { maxAccumulatedCostUsd: 100, accountant },
});

accountant.getAccumulatedMicroUsd("openai"); // committed
accountant.getReservedMicroUsd("openai"); // in flight
```

Sharing one accountant across clients gives them a shared budget.

## Process-local only

All accounting is in-memory and per process. Ten replicas with `maxAccumulatedCostUsd: 100` allow
$1000 of aggregate spend. There is no Redis or distributed backend in this release.

Options today: divide the cap by replica count, or implement a `BudgetAccountant` over shared storage —
keeping in mind that the interface is synchronous, so a network-backed ledger needs a local cache with
periodic reconciliation rather than a per-call round trip.

## Errors and events

`LlmBudgetExceededError` extends `LlmError` with `classification: "budget"`, `retryable: false`, and
`code: "ERR_LLM_BUDGET"`, plus `scope`, `limitKind`, `limitMicroUsd`, `accumulatedMicroUsd`, and
`attemptedMicroUsd`.

`limitKind` is `"per-request"`, `"accumulated"`, or `"unknown-pricing"`.

```ts
import { LlmBudgetExceededError } from "@resili/llm";

try {
  await llm.generate({ input: prompt, estimatedInputTokens: 900, estimatedOutputTokens: 500 });
} catch (error) {
  if (error instanceof LlmBudgetExceededError) {
    console.error(error.limitKind, error.scope, error.attemptedMicroUsd, error.limitMicroUsd);
  }
}
```

Events:

```ts
llm.on("LlmBudgetWarning", (event) => {
  console.warn(`${event.scope}: ${event.accumulatedMicroUsd}/${event.limitMicroUsd}`);
});
llm.on("LlmBudgetRejected", (event) => {
  console.error(`rejected: ${event.limitKind} on ${event.scope}`);
});
```

Metric: `resili_llm_budget_rejections_total`, labelled `result: "budget_rejected"`.

Because the error is non-retryable, retry does not attempt it again — which is correct, since the
budget will not have grown.

## Scopes

The default scope is the provider name. A resolver lets you partition by tenant, user, or day:

```ts
budget: {
  maxAccumulatedCostUsd: 10,
  scope: (request, ctx) => `tenant:${String(ctx.metadata.get("tenantId") ?? "unknown")}`,
}
```

Scopes are independent ledgers; the cap applies per scope, not in aggregate.

## Graceful degradation

Because a budget rejection is an error, [fallback](../core/fallback.md) can turn it into a product
behavior:

```ts
const llm = createLlmClient({
  provider,
  pricing,
  budget: { maxAccumulatedCostUsd: 50 },
  fallback: {
    fallbackOn: (error) => error instanceof LlmBudgetExceededError,
    handler: () => ({
      provider: "budget-fallback",
      model: "none",
      content: "This feature is temporarily unavailable.",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop" as const,
    }),
  },
});
```

## Limitations

- Process-local; not distributed.
- `maxCostPerRequestUsd` checks the estimate, not actual spend.
- Missing estimates mean a zero reservation, so concurrent requests can overshoot the accumulated cap.
- Retries are billable but covered by one reservation.
- Interrupted streams settle zero; real provider billing may be unrepresented.
- `usage.dimensions` (cached, reasoning, thinking tokens) is recorded but not priced, so cost can
  under-report where those are billed separately.
- Custom accountants must keep `reserve`/`settle` synchronous and atomic.
