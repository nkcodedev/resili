# Quick start

Every example below is complete and runnable against the current beta packages.

## Wrap any async function

`createClient` takes an operation and a declarative config, and returns a client whose `call`
preserves the original signature.

```ts
import { createClient } from "@resili/core";

const users = createClient(
  async (id: string) => {
    const response = await fetch(`https://api.example.com/users/${id}`);
    return (await response.json()) as { id: string; name: string };
  },
  {
    timeout: { perAttemptMs: 1_000 },
    retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 100, jitter: "none" },
  },
);

const user = await users.call("42");
await users.destroy();
```

`client.execute(fn)` is the context-aware alternative: the function receives the per-attempt
[`Context`](../core/execution-context.md), including the composed `AbortSignal`.

## Or use the fluent builder

The builder is equivalent to `createClient` and useful when configuration lives next to the
operation.

```ts
import { resili } from "@resili/core";

const client = resili((url: string) => fetch(url))
  .timeout({ perAttemptMs: 2_000 })
  .retry({ maxAttempts: 3, jitter: "none" })
  .circuitBreaker({ minimumThroughput: 10, failureRateThreshold: 50 })
  .build();

const response = await client.call("https://api.example.com/health");
```

`failureRateThreshold` is a **percentage** (`50` means 50%), not a ratio. See
[Circuit breaker](../core/circuit-breaker.md).

## fetch

```ts
import { createFetch } from "@resili/fetch";

const resilientFetch = createFetch({
  timeout: { perAttemptMs: 1_000 },
  retry: { maxAttempts: 3, jitter: "none" },
});

const response = await resilientFetch("https://api.example.com/users");
```

The adapter returns the raw `Response`. It does not treat a 5xx status as a failure by itself — see
[fetch adapter](../http/fetch.md) for how to classify statuses.

## axios

`@resili/axios` never imports `axios`; you inject the implementation you already own.

```ts
import axios from "axios";
import { createAxios } from "@resili/axios";

const client = createAxios({
  axios: (config) => axios.request(config),
  retry: { maxAttempts: 2, jitter: "none" },
  timeout: { perAttemptMs: 1_000 },
});

const response = await client.get("https://api.example.com/users");
```

## undici

```ts
import { request } from "undici";
import { createUndici } from "@resili/undici";

const send = createUndici({
  request: (options) => request(`${options.origin}${options.path}`, options),
  retry: { maxAttempts: 2, jitter: "none" },
});

const response = await send({
  origin: "https://api.example.com",
  path: "/users",
  method: "GET",
});
```

## LLM `generate()`

You construct and own the vendor client. Resili never reads an API key.

```ts
import OpenAI from "openai";
import { createLlmClient, createPricingResolver } from "@resili/llm";
import { createOpenAiProvider } from "@resili/llm-openai";

const llm = createLlmClient({
  provider: createOpenAiProvider({
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: "gpt-4.1-mini",
  }),
  model: "gpt-4.1-mini",
  timeout: { perAttemptMs: 30_000 },
  retry: { maxAttempts: 3, jitter: "none" },
  pricing: createPricingResolver([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokensUsd: 0.4,
      outputPerMillionTokensUsd: 1.6,
    },
  ]),
});

const result = await llm.generate({ input: "Explain circuit breakers in one sentence." });

console.log(result.response.content);
console.log(result.usage.totalTokens, result.cost?.totalCostUsd);

await llm.destroy();
```

See [LLM generate](../llm/generate.md).

## LLM `stream()`

Streaming is pull-through: provider chunks are read in response to your loop, and one logical stream
always comes from a single provider generation.

```ts
const stream = llm.stream({ input: "Explain circuit breakers." });

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }

  if (event.type === "completed") {
    console.log("\n", event.usage.totalTokens, event.finishReason);
  }
}

const result = await stream.result();
```

`result()` does not start the provider on its own — iterate (or call `next()`) to begin execution.
See [LLM streaming](../llm/streaming.md).

## Next steps

- [Concepts](concepts.md)
- [Core policies](../core/policies.md)
- [Policy ordering](../core/policy-ordering.md)
