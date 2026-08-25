# Alpha status

**Stage: Alpha.** Eight packages published to the npm `alpha` dist-tag, with the full test suite,
type-checking, API-report verification, and public-registry consumer verification green.

| Line        | Packages                                       | Current         |
| ----------- | ---------------------------------------------- | --------------- |
| Core + HTTP | `@resili/core`, `-fetch`, `-axios`, `-undici`  | `0.2.0-alpha.3` |
| LLM         | `@resili/llm`, `-llm-openai`, `-llm-anthropic` | `0.1.0-alpha.4` |
|             | `@resili/llm-gemini`                           | `0.1.0-alpha.3` |

## Suitable for

- Evaluation and prototyping
- Integration testing against real providers
- Early adoption where you can pin exact versions and absorb a breaking change between alphas
- Internal services and non-critical paths

## Not yet claimed

- **API stability.** Public surfaces may change between alpha releases.
- **Semver guarantees.** While the major version is `0`, a minor bump may break.
- **Production compatibility commitments.** No LTS window, no deprecation cycle yet.

Pin exact versions and read the [CHANGELOG](../../CHANGELOG.md) before upgrading. Behavior can change
without a type-level signal — the `alpha.4` streaming fix is the clearest example.

## Implemented

### Core

Nine policies, all with tests: [retry](../core/retry.md), [timeout](../core/timeout.md),
[circuit breaker](../core/circuit-breaker.md), [rate limiter](../core/rate-limiter.md),
[bulkhead](../core/bulkhead.md), [cache](../core/cache.md), [fallback](../core/fallback.md),
[dedupe](../core/dedupe.md), [hedge](../core/hedge.md).

Around them: a [deterministic pipeline](../core/policy-ordering.md) with configurable ordering and
relative anchors; an [immutable execution context](../core/execution-context.md) with `AbortSignal`
composition and fork semantics; [pluggable failure classification](../architecture/error-classification.md);
a typed [event bus](../observability/events.md) and [metrics contract](../observability/metrics.md);
custom policies via `definePolicy` and plugins via `definePlugin`; an injectable `Clock` for
deterministic tests.

`@resili/core` has **zero runtime dependencies**.

### HTTP

[fetch](../http/fetch.md), [axios](../http/axios.md), and [undici](../http/undici.md) adapters. All
policies apply, `AbortSignal` propagates, and axios and undici take an injected implementation so you
keep control of the client and its version.

### LLM

A provider-neutral client — [`generate()`](../llm/generate.md) and
[`stream()`](../llm/streaming.md) — over [OpenAI](../providers/openai.md),
[Anthropic](../providers/anthropic.md), and [Gemini](../providers/gemini.md).

Provider SDK retries are disabled in all three adapters so that Resili owns retry behavior
exclusively. [Normalized usage](../llm/usage.md), [micro-USD pricing and cost](../llm/pricing.md),
[Budget Guard](../llm/budget-guard.md) with estimated reservation and actual settlement, a
[provider-neutral error model](../llm/errors.md), and nine LLM event types.

### Streaming

Pull-through streaming: provider chunks are pulled in response to consumer demand, with no intentional
buffering of the complete response.

The [commit point](../llm/streaming.md#the-commit-point) is the central correctness guarantee. Once
the first non-empty text delta reaches the consumer, the stream is committed and Resili will not start
another provider generation. Before commit, retryable failures retry normally.

`0.1.0-alpha.4` fixed a defect where a post-commit timeout could trigger a retry, concatenating two
generations into one corrupt answer. Post-commit timeouts are now terminal:
`LlmError("timeout")` with `retryable: false`.

### Privacy

Resili sends no outbound telemetry. Events, metrics, and error messages carry no prompts, generated
text, raw provider chunks, API keys, or `Authorization` headers.
→ [Telemetry](../observability/telemetry.md)

## Known limitations

### Streaming

- `perAttemptMs` covers the **entire** streaming attempt, including time the consumer spends between
  pulls. A slow consumer can trip the timeout.
- No separate time-to-first-token timeout.
- No separate idle / inter-chunk timeout.
- `result()` does not start execution — the consumer must iterate or call `next()`.
- An interrupted stream may not carry authoritative provider usage, so cost for that request may be
  incomplete. → [Budget Guard](../llm/budget-guard.md#the-interrupted-stream-gap)
- One consumer per stream; concurrent `next()` calls are rejected.

### Core

- `retry.jitter` accepts only `"none"`; `"full"` and `"equal"` throw `ConfigurationError`.
- `retry.idempotentOnly` must remain `false`.
- `timeout.deadlineMs` is validated but not enforced as a runtime limit — there is no total-request
  deadline, only per-attempt timeouts.
- `hedge.maxAttempts` must be `2`.
- All policy state is in-memory and per-process. Breaker state, rate limits, bulkhead slots, cache
  entries, and budget totals are **not** shared across instances or replicas. `StateStore` is the seam
  for this; no distributed implementation ships yet.
- Cache eviction is FIFO, not LRU, and concurrent misses are not deduplicated (compose with
  [dedupe](../core/dedupe.md)).

### HTTP

- HTTP status codes are **not** classified as failures by default. A 503 is a returned value; opt in
  with `retry.retryOn`. → [HTTP overview](../http/overview.md#status-codes-are-not-classified-by-default)
- Adapters overwrite the signal on your request arguments and expose no per-call options, so
  caller-initiated cancellation is not supported through them — only timeout-driven cancellation.
  Wrap the HTTP call with `@resili/core` directly if you need to abort from the caller.
- Adapters do not disable retry behavior in an injected client. An axios instance with a retry
  interceptor, or an undici `RetryAgent`, will retry inside each Resili attempt.
- A one-shot request body (a stream) cannot be replayed on retry.
- axios and undici are typed structurally, so library-specific features — interceptors, dispatchers —
  are not exposed.

### LLM

- Budget accounting is process-local.
- `maxCostPerRequestUsd` is compared against your **estimate**, so actual cost can exceed it.
- Pricing tables are caller-supplied; Resili ships none and cannot know your negotiated rates.
- Only the first choice / candidate of a provider response is surfaced.
- OpenAI support targets Chat Completions. The Responses API is **deferred**, not implemented.
- Requests are text in, text out: `input` is a single string. No tool calls, structured output,
  vision, multi-turn message arrays, or embeddings.
- `usage.dimensions` are recorded but not priced. Cost uses input and output tokens only.

## Not implemented

Azure OpenAI and Bedrock adapters, OpenTelemetry and Prometheus plugin packages, distributed state
adapters, framework middleware, and a built-in token estimator.

Azure OpenAI can be reached today by pointing an injected OpenAI client at your deployment — see
[OpenAI](../providers/openai.md#azure-openai-and-compatible-gateways).

Nothing here is documented as available anywhere else in these docs. If you find a claim that
contradicts this page, the code is the authority and the doc is a bug.

## Toward beta

The next milestone is a beta readiness review. The themes under consideration are API surface
stabilization, finer-grained streaming timeouts, distributed policy state, and first-party telemetry
integrations. Nothing on that list is committed or scheduled.

## Reporting

Issues and API feedback are welcome. Behavioral reports are most useful with the exact package
versions (`npm ls @resili/core @resili/llm`), the client configuration, and whether the case is
pre- or post-commit if streaming is involved.
