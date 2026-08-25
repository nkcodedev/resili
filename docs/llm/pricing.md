# Pricing and cost

Resili computes cost from a price table **you** supply. No vendor prices are hard-coded, because they
change without notice and a stale built-in table would silently produce wrong numbers.

## Flow

```text
provider response
    ↓
normalized usage        inputTokens / outputTokens / totalTokens
    ↓
pricing resolver        provider + model → PricingRate
    ↓
cost                    integer micro-USD, plus decimal USD for display
```

## Defining a price table

```ts
import { createPricingResolver } from "@resili/llm";

const pricing = createPricingResolver([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokensUsd: 0.4,
    outputPerMillionTokensUsd: 1.6,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputPerMillionTokensUsd: 3,
    outputPerMillionTokensUsd: 15,
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    inputPerMillionTokensUsd: 0.3,
    outputPerMillionTokensUsd: 2.5,
  },
]);

const llm = createLlmClient({ provider, pricing });
```

```ts
interface ModelPricing {
  readonly provider: string;
  readonly model: string;
  readonly inputPerMillionTokensUsd: number;
  readonly outputPerMillionTokensUsd: number;
}
```

Prices are per **million tokens**, matching how vendors publish them. A duplicate
`provider` + `model` pair raises a `ConfigurationError` at construction rather than silently letting
one row win.

`provider` must match the adapter's own name — `"openai"`, `"anthropic"`, or `"gemini"` — and `model`
must match the model string the provider **returned**, which is not always what you requested. Ask for
`gpt-4.1-mini` and you may get `gpt-4.1-mini-2025-04-14`; that dated snapshot is the lookup key. Log
`response.model` to discover the values you actually need rows for.

## Micro-USD

Costs are computed as **integer micro-USD**: `1 USD = 1_000_000 micro-USD`.

```ts
import { microUsdToUsd, usdToMicroUsd, TOKENS_PER_MILLION, USD_MICROS } from "@resili/llm";

USD_MICROS; // 1_000_000
TOKENS_PER_MILLION; // 1_000_000

usdToMicroUsd(0.0015); // 1500
microUsdToUsd(1500); // 0.0015
```

The reason is accumulation. Per-request costs are frequently fractions of a cent, and summing
thousands of IEEE-754 doubles drifts. Integers do not, which is what lets Budget Guard compare
reliably.

Rounding is **round-half-up**, applied per channel:

```text
inputCostMicroUsd  = round_half_up(inputTokens  × inputMicroUsdPerMillionTokens  / 1_000_000)
outputCostMicroUsd = round_half_up(outputTokens × outputMicroUsdPerMillionTokens / 1_000_000)
totalCostMicroUsd  = inputCostMicroUsd + outputCostMicroUsd
```

Input and output are rounded separately, then added — so the total is not necessarily the rounding of
the exact sum. The difference is at most one micro-USD.

## `LlmCost`

```ts
interface LlmCost {
  readonly provider: string;
  readonly model: string;
  readonly inputCostMicroUsd: number;
  readonly outputCostMicroUsd: number;
  readonly totalCostMicroUsd: number;
  readonly inputCostUsd: number;
  readonly outputCostUsd: number;
  readonly totalCostUsd: number;
  readonly currency: "USD";
}
```

| Use for                                     | Field               |
| ------------------------------------------- | ------------------- |
| Budgets, comparisons, metrics, accumulation | `totalCostMicroUsd` |
| Display, logs, invoices                     | `totalCostUsd`      |

The `Usd` fields are `micro / 1_000_000` — convenience, not a second source of truth. Accumulate in
micro-USD and convert once at the edge.

## Unknown prices are `undefined`, not zero

```ts
const result = await llm.generate({ input: prompt });

if (result.cost === undefined) {
  // No pricing resolver, or no row for this provider/model pair.
}
```

`undefined` deliberately means _unknown_. Treating it as `$0` would make an unpriced model look free —
the exact failure mode a budget exists to prevent. For the same reason, Budget Guard's
`onUnknownPricing` defaults to `"reject"`. See [Budget Guard](budget-guard.md).

Guard against accidental zeroing:

```ts
// ❌ silently treats unknown as free
total += result.cost?.totalCostMicroUsd ?? 0;

// ✅ surfaces the gap
if (result.cost === undefined) {
  metrics.increment("llm.unpriced_model", { model: result.response.model });
} else {
  total += result.cost.totalCostMicroUsd;
}
```

## Worked example

`gpt-4.1-mini` at $0.40 in / $1.60 out per million tokens, with 1,200 input and 350 output tokens:

```text
input:  1200 × 400_000 / 1_000_000 =   480 micro-USD
output:  350 × 1_600_000 / 1_000_000 = 560 micro-USD
total:                                1040 micro-USD  =  $0.00104
```

```ts
result.cost?.inputCostMicroUsd; // 480
result.cost?.outputCostMicroUsd; // 560
result.cost?.totalCostMicroUsd; // 1040
result.cost?.totalCostUsd; // 0.00104
```

## Only input and output are priced

Cost uses `inputTokens` and `outputTokens` only. Vendor-specific counts under
[`usage.dimensions`](usage.md) — cached input tokens, reasoning tokens, thinking tokens — are recorded
but **not** priced.

Where a vendor bills those at a different rate, Resili's cost will not match your invoice. Cached input
is the common case: it is often much cheaper than fresh input, so a heavily cached workload will be
_over_-reported, while separately billed reasoning tokens will be _under_-reported. Reconcile against
provider billing when the difference is material.

## Streaming

Identical mechanics. The `completed` event and `result()` carry cost computed from authoritative usage
when the provider reports it.

Interrupted streams typically carry no usage frame, so there is no cost to compute — see
[Streaming](streaming.md) and [Cancellation](cancellation.md).

## Direct calculation

The primitives are exported if you want to price usage outside a client:

```ts
import { calculateCost, createPricingResolver, normalizeUsage } from "@resili/llm";

const pricing = createPricingResolver([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokensUsd: 0.4,
    outputPerMillionTokensUsd: 1.6,
  },
]);

const rate = pricing.resolve("openai", "gpt-4.1-mini");

if (rate !== undefined) {
  const cost = calculateCost(normalizeUsage({ inputTokens: 1_200, outputTokens: 350 }), rate);
  console.log(cost.totalCostMicroUsd); // 1040
}
```

Useful for pre-flight estimates, offline reporting, or comparing models before you call one.

## Keeping the table current

Vendor prices change. Some practices that help:

- Keep the table in configuration, not code, so a price change is a deploy-free update.
- Include dated model snapshots, not just aliases, since the response reports the snapshot.
- Alert on `cost === undefined` — it usually means a new model appeared without a price row.
- Re-check published prices when you adopt a new model.

## Limitations

- No built-in vendor price data.
- Only input and output tokens are priced; `dimensions` are not.
- No tiered, cached, or batch-discount pricing model.
- USD only (`currency` is the literal `"USD"`).
- Lookup is an exact `provider` + `model` match — no wildcards or prefix matching.
- Interrupted streams may have no usage, so no cost.
