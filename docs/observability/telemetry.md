# Telemetry and privacy

Resili's telemetry is designed so that enabling it cannot leak sensitive data. This page states the
guarantees, what they do and do not cover, and how to keep your own instrumentation aligned.

## No outbound telemetry

Resili sends nothing anywhere. There is no phone-home, no analytics endpoint, no Resili service.
`@resili/core` has zero runtime dependencies, and `@resili/llm` performs no network I/O of its own —
the only outbound traffic is your operation calling your dependency.

[Events](events.md) and [metrics](metrics.md) are delivered to handlers **you** register, in your
process. Nothing is emitted until you subscribe.

## What is never in a payload

No event or metric payload contains:

- Prompt text or any request input
- Generated text, completions, or model output
- Raw provider chunks or stream frames
- HTTP request or response bodies
- API keys, tokens, or credentials
- `Authorization` headers or any header values
- Cache keys or dedupe keys

The exclusions on the last line are less obvious than the rest: keys are derived from your operation's
arguments, which routinely contain user identifiers, so they are omitted from event payloads even
though the policies that generate them emit events.

## Why text is excluded

The convenient thing would be to put the prompt on `LlmRequestStarted` for debugging. It is excluded
because telemetry has a way of ending up everywhere — logs, third-party APMs, long-retention storage,
support tickets — and prompts routinely contain personal data, customer records, credentials pasted by
users, and proprietary content.

Once telemetry is a safe surface, you can log it liberally without a compliance review. That is worth
more than the debugging convenience.

## What events do carry

Enough to operate the system, and nothing that identifies content:

| Category   | Examples                                                          |
| ---------- | ----------------------------------------------------------------- |
| Identity   | `requestId`, `operationName`, `serviceName`                       |
| Timing     | `timestamp`, `durationMs`, `delayMs`, `ttftMs`                    |
| Counts     | `attempts`, `chunkCount`, token counts, `queueSize`               |
| Outcomes   | `status`, `errorCode`, `classification`, `retryable`, `committed` |
| Cost       | `costMicroUsd`, `limitMicroUsd`, `accumulatedMicroUsd`            |
| Partitions | policy `key`, budget `scope`                                      |
| Model info | `provider`, `model` (LLM events only)                             |

Token counts describe volume, not content — 400 output tokens says nothing about what was generated.

### Two fields to note

Policy `key` and budget `scope` are values **you** choose. If you set
`key: (ctx) => String(ctx.metadata.get("email"))`, that email appears in event payloads and, for
policy metrics, as a metric label. Use opaque identifiers:

```ts
// ❌ leaks PII into telemetry, and creates unbounded metric cardinality
key: (ctx) => String(ctx.metadata.get("userEmail"));

// ✅ opaque and bounded
key: (ctx) => `tenant-${String(ctx.metadata.get("tenantId"))}`;
```

## Errors

Resili-generated error messages contain no prompts, completions, or credentials.

`LlmError.cause` holds the **original SDK error**, and each adapter attaches a redacted summary —
`name`, `status`, `code`/`type`, `requestID`. Secret-looking values are redacted from the code and type
fields.

The caveat: `cause` is the vendor's error object, and Resili does not rewrite its internals. Vendor
SDKs generally do not embed prompts in error messages, but if you log a whole error tree you are
logging the vendor's payload, not just Resili's. Log the fields you need:

```ts
if (isLlmError(error)) {
  const cause = error.cause as { status?: number; requestID?: string } | undefined;
  logger.error({
    classification: error.classification,
    retryable: error.retryable,
    status: cause?.status,
    requestID: cause?.requestID, // what provider support will ask for
  });
}
```

## Streaming

Text deltas are **not** published on the event bus. A stream's telemetry is three events —
`LlmStreamStarted`, `LlmStreamCompleted`, `LlmStreamFailed` — carrying timing, counts, cost, and
outcome. The text goes to your consumer only.

`LlmStreamFailed.committed` says _whether_ text was delivered, never what it was. It is the most
operationally useful field in LLM telemetry: a committed failure means a user saw a truncated answer,
which cannot be retried and deserves its own alert.

## Metric cardinality

The same privacy design produces the cardinality discipline described in
[Metrics](metrics.md#cardinality-is-a-hard-rule):

- `requestId` must **never** be a metric label.
- LLM metrics carry only `result`. Provider, model, prompt, user, and request id are excluded.
- Core policy metrics carry `service`, `operation`, and a small enumerated label such as `reason` or
  `winner`.

Per-request detail belongs in events; aggregates belong in metrics. That split is what keeps a metrics
backend from exploding.

## API keys

Keys never enter Resili.

You construct the vendor SDK client and pass it to the adapter. **No adapter constructs a client,
reads `apiKey`, or reads an environment variable.** The key lives in your closure, is never placed on
`LlmRequest`, is never stored, and is never logged.

```ts
// The key is yours, in your code, and never handed to Resili.
const provider = createOpenAiProvider({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
});
```

## Your own instrumentation

The guarantees cover Resili's payloads, not what you do with them.

```ts
// ❌ Puts the prompt in your logs
llm.on("LlmRequestStarted", () => logger.info({ prompt }));

// ❌ Unbounded metric cardinality
llm.on("LlmRequestCompleted", (e) => metric.add(1, { requestId: e.requestId }));

// ✅ Safe: identifiers, counts, outcomes
llm.on("LlmRequestCompleted", (e) =>
  logger.info({
    requestId: e.requestId,
    provider: e.provider,
    model: e.model,
    totalTokens: e.totalTokens,
    costMicroUsd: e.costMicroUsd,
    durationMs: e.durationMs,
  }),
);
```

If you must log prompts for debugging, do it deliberately: behind a flag, with short retention, and
outside the telemetry path.

## Verifying it yourself

The guarantees are covered by tests that serialize every emitted event and assert that prompt text,
output text, and key-like strings are absent. To check in your own environment:

```ts
const captured: unknown[] = [];
for (const type of ["LlmRequestStarted", "LlmRequestCompleted", "LlmUsageRecorded"] as const) {
  llm.on(type, (event) => captured.push(event));
}

await llm.generate({ input: "SECRET_PROMPT_MARKER" });

const serialized = JSON.stringify(captured);
console.assert(!serialized.includes("SECRET_PROMPT_MARKER"));
console.assert(!serialized.includes("sk-"));
```

## Summary

| Guarantee                                           | Scope            |
| --------------------------------------------------- | ---------------- |
| No outbound telemetry from Resili                   | All packages     |
| No prompts or completions in events or metrics      | Core and LLM     |
| No credentials or auth headers in events or metrics | Core and LLM     |
| No raw provider chunks in events                    | LLM streaming    |
| No cache or dedupe keys in event payloads           | Core policies    |
| API keys never read or stored by Resili             | All LLM adapters |
| `requestId` never a metric label                    | All metrics      |
| Text deltas never on the event bus                  | LLM streaming    |

Not covered: vendor SDK error internals reachable through `LlmError.cause`, values you place in a
policy `key` or budget `scope`, and your own logging.
