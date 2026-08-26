# HTTP adapter Beta API freeze record

**Status:** Freeze candidate after Milestone 6 on `chore/beta-packaging-ci`.

**Scope:** `@resili/fetch`, `@resili/axios`, `@resili/undici`.

This is **not** a Core or LLM freeze (those have their own records) and is **not** a declaration that Resili is published as Beta.

Runtime, tests, packed artifacts, and API Extractor reports override this document when they disagree.

## HTTP Beta Freeze Candidate

| Package          | Verdict | Notes                                                                                     |
| ---------------- | ------- | ----------------------------------------------------------------------------------------- |
| `@resili/fetch`  | **YES** | `createFetch` remains fetch-shaped; caller `init.signal` is composed into Core execution  |
| `@resili/axios`  | **YES** | Injected `axios` implementation; HTTP methods + callable; caller `config.signal` composed |
| `@resili/undici` | **YES** | Injected `request` function; caller `options.signal` composed                             |

All three now expose a **minimal** Core lifecycle surface: `on` and `destroy`. They do **not** expose `Client`, `execute`, `call`, `stats()`, or `health()`.

## Classification

Public exports are **KEEP** unless listed.

| Decision           | Meaning                                    |
| ------------------ | ------------------------------------------ |
| KEEP               | Freeze for the remainder of Beta hardening |
| REVIEW             | Honest but not a product promise           |
| CHANGE BEFORE BETA | None remaining after this milestone        |
| INTERNALIZE        | None                                       |
| DEPRECATE          | None                                       |

### `@resili/fetch`

| Export                | Class | Notes                                            |
| --------------------- | ----- | ------------------------------------------------ |
| `createFetch`         | KEEP  | Factory; default transport is `globalThis.fetch` |
| `CreateFetchOptions`  | KEEP  | `ResiliConfig<Response>` plus optional `fetch`   |
| `FetchImplementation` | KEEP  | Injected transport type                          |
| `ResilientFetch`      | KEEP  | Call signature + `on` + `destroy`                |

### `@resili/axios`

| Export                | Class  | Notes                                                                |
| --------------------- | ------ | -------------------------------------------------------------------- |
| `createAxios`         | KEEP   | Requires injected `axios` (no default global client)                 |
| `CreateAxiosOptions`  | KEEP   | `ResiliConfig<AxiosResponse>` plus `axios`                           |
| `AxiosImplementation` | KEEP   | Structural DI                                                        |
| `AxiosRequestConfig`  | REVIEW | Index signature; not a full Axios typings replica                    |
| `AxiosResponse`       | REVIEW | Structural; not `axios` package types                                |
| `ResilientAxios`      | KEEP   | Callable + `request`/`get`/`delete`/`post`/`put`/`patch` + lifecycle |

### `@resili/undici`

| Export                 | Class  | Notes                                           |
| ---------------------- | ------ | ----------------------------------------------- |
| `createUndici`         | KEEP   | Requires injected `request`                     |
| `CreateUndiciOptions`  | KEEP   | `ResiliConfig<UndiciResponse>` plus `request`   |
| `UndiciImplementation` | KEEP   | Structural DI                                   |
| `UndiciRequestOptions` | REVIEW | Index signature; not full Undici Dispatcher API |
| `UndiciResponse`       | REVIEW | Structural                                      |
| `ResilientUndici`      | KEEP   | Call signature + `on` + `destroy`               |

No CHANGE BEFORE BETA items remain for these packages. Index-signature HTTP types stay REVIEW: they are intentional structural types for injection, not a promise to match every Axios/Undici release.

## Adapter factories

- **fetch:** `createFetch(options?: CreateFetchOptions): ResilientFetch`
- **axios:** `createAxios(options: CreateAxiosOptions): ResilientAxios` — `axios` is required
- **undici:** `createUndici(options: CreateUndiciOptions): ResilientUndici` — `request` is required

Callers still configure resilience through Core `ResiliConfig` fields on the factory options. Per-call policy overrides are not added.

## Caller signal behavior

Unchanged from Milestone 3:

- Fetch: `init.signal` is passed to `client.execute(..., { signal })`. Transport receives composed `ctx.signal`.
- Axios: `config.signal` similarly.
- Undici: `options.signal` similarly.
- Already-aborted signals fail without calling the transport.
- Abort is not a classified failure and is not retryable.

## Injected client / transport types

HTTP adapters do not take a live `axios` npm instance or Undici `Agent` as a branded type. They take **structural** functions so tests and fakes work without coupling to a specific SDK major. That remains KEEP/REVIEW as above, not a Beta blocker.

## Error types

Adapters throw Core errors (`AbortError`, policy errors) and transport errors unchanged. They do not introduce HTTP-specific public error classes.

## Lifecycle

**Exposed:** `on(type, handler): Unsubscribe` and `destroy(): Promise<void>`.

**Not exposed:** full `Client`, `stats()`, `health()`, `execute`.

Rationale: P1 readiness called out missing event/cleanup access. Users wrapping fetch/axios/undici need to unsubscribe and dispose without dropping down to `createClient`. `stats()`/`health()` remain Core-only because HTTP wrappers are not a second health API.

`destroy` is idempotent (Core guarantee). `on` returns the same unsubscribe function Core returns. Cancellation is unchanged.

## Events

`on` is the Core event bus (`CallStarted`, `RetryStarted`, `TimeoutTriggered`, …). LLM-specific events are not on HTTP adapters.

## Configuration types

`Create*Options` extend `ResiliConfig`. Removing that coupling would be a redesign; it stays KEEP.

## API Extractor

Committed reports:

- `packages/fetch/etc/fetch.api.md`
- `packages/axios/etc/axios.api.md`
- `packages/undici/etc/undici.api.md`

Root `pnpm api:check` covers all eight publishable packages and fails if reports drift (`api-extractor run` without `--local`).

Forgotten-export warnings for Core types referenced in HTTP signatures (`EventHandler`, `ResiliEventType`, `Unsubscribe`, `ResiliConfig`) are accepted: those types live on `@resili/core`. Re-exporting them from HTTP packages would invent a second public home for Core types.

## BETA FREEZE CANDIDATE

- `@resili/fetch`: **YES**
- `@resili/axios`: **YES**
- `@resili/undici`: **YES**
