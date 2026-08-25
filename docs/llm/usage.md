# Usage accounting

Every provider reports token usage under a different name. `@resili/llm` normalizes it to one shape,
while preserving vendor-specific counts.

## `LlmUsage`

```ts
interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly dimensions?: Readonly<Record<string, number>>;
}
```

The three core counts are **always present**. Missing provider values become `0` rather than
`undefined`, so arithmetic never needs a guard:

```ts
const result = await llm.generate({ input: prompt });
result.usage.inputTokens + result.usage.outputTokens; // always safe
```

`totalTokens` is taken from the provider when reported, and derived as
`inputTokens + outputTokens` when it is not.

`normalizeUsage` also sanitizes hostile input: negative values, `NaN`, and `Infinity` all become `0`.

```ts
import { normalizeUsage } from "@resili/llm";

normalizeUsage(undefined); // { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
normalizeUsage({ inputTokens: 10, outputTokens: 5 }); // totalTokens: 15
```

Zeros mean "not reported", which is worth remembering: a successful call whose usage is all zeros
means the provider omitted usage, not that no tokens were consumed. Cost for such a call will be zero
and therefore understated.

## Provider mapping

Each adapter maps its SDK's fields to the normalized shape.

| Normalized     | OpenAI              | Anthropic       | Gemini                 |
| -------------- | ------------------- | --------------- | ---------------------- |
| `inputTokens`  | `prompt_tokens`     | `input_tokens`  | `promptTokenCount`     |
| `outputTokens` | `completion_tokens` | `output_tokens` | `candidatesTokenCount` |
| `totalTokens`  | `total_tokens`      | _(derived)_     | `totalTokenCount`      |

Anthropic's Messages API reports no total, so it is derived from the two counts.

## Dimensions

Vendor-specific counts are preserved verbatim under `dimensions`, keyed with names close to the
provider's own.

| Adapter   | Dimension keys                                                             |
| --------- | -------------------------------------------------------------------------- |
| OpenAI    | `cachedTokens`, `reasoningTokens`                                          |
| Anthropic | `cacheCreationInputTokens`, `cacheReadInputTokens`, `thinkingTokens`       |
| Gemini    | `cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount` |

`dimensions` is present only when the provider reported at least one such count.

```ts
const cached = result.usage.dimensions?.cachedTokens ?? 0;
const reasoning = result.usage.dimensions?.reasoningTokens ?? 0;
```

**Dimensions are recorded but not priced.** [Cost](pricing.md) uses `inputTokens` and `outputTokens`
only. Where a vendor bills a dimension at a different rate, Resili's cost will diverge from your
invoice — cached input is usually cheaper (so Resili over-reports) while reasoning tokens are often
billed as output at a premium (so Resili may under-report). Watch these counts when they are material
and reconcile against provider billing.

Adding a new dimension key is not a breaking change, so treat the set as open and read defensively.

## Streaming usage

Streaming providers report usage across several frames — an initial frame with input tokens, later
frames refining output counts. Resili merges them shallowly as they arrive.

The important property: **a later frame that omits a count does not zero an earlier one.** A frame
carrying only `output_tokens` leaves the previously reported `input_tokens` intact. When the stream
ends, whatever was never reported normalizes to `0`.

```ts
for await (const event of stream) {
  if (event.type === "completed") {
    event.usage.inputTokens; // merged across frames
    event.usage.outputTokens;
    event.usage.totalTokens;
  }
}
```

Only the final `completed` event (and `result()`) carries usage; individual `text-delta` events do not.

To request usage on an OpenAI stream the adapter always sends `stream_options: { include_usage: true }` —
without it the SDK omits usage entirely.

### Interrupted streams

An aborted, timed-out, or broken-out-of stream usually never receives the final usage frame. There is
no `completed` event and `result()` rejects, so **there is no authoritative usage to read**.

Resili does not estimate token counts for interrupted streams. The provider may still have billed for
what it generated; that spend is unrepresented. See [Cancellation](cancellation.md).

## Events and metrics

Usage appears on `LlmRequestCompleted`, `LlmUsageRecorded`, and `LlmStreamCompleted`:

```ts
llm.on("LlmUsageRecorded", (event) => {
  console.log(event.provider, event.model, event.totalTokens, event.costMicroUsd);
});
```

Counters: `resili_llm_input_tokens_total`, `resili_llm_output_tokens_total`,
`resili_llm_tokens_total`, and `resili_llm_stream_output_tokens_total`.

Note that metrics carry only a `result` label — **not** provider or model — to keep cardinality low. If
you need per-model token attribution, aggregate from events rather than metrics. See
[Metrics](../observability/metrics.md).

## Estimating usage

Budget Guard's preflight needs an estimate before the call, since real usage does not exist yet:

```ts
await llm.generate({
  input: prompt,
  estimatedInputTokens: Math.ceil(prompt.length / 4),
  estimatedOutputTokens: 500, // your max_tokens cap is a good conservative bound
});
```

Roughly four characters per token holds for English prose; code and non-Latin scripts are denser. Use a
real tokenizer if you need precision. Omitting estimates yields a zero-cost preflight, which
effectively disables per-request rejection — see [Budget Guard](budget-guard.md).

## Aggregating usage

```ts
const totals = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, unpriced: 0 };

llm.on("LlmUsageRecorded", (event) => {
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  if (event.costMicroUsd === undefined) {
    totals.unpriced += 1;
  } else {
    totals.costMicroUsd += event.costMicroUsd;
  }
});
```

Accumulate cost in integer micro-USD and convert once for display. Tracking `unpriced` separately
prevents a missing price row from quietly reading as free spend.

## Limitations

- Missing counts normalize to `0`, indistinguishable from a genuine zero.
- `dimensions` is recorded but not priced.
- Anthropic totals are derived, not provider-reported.
- Interrupted streams may carry no usage at all.
- Metrics do not carry provider or model labels.
- There is no built-in tokenizer for estimates.
