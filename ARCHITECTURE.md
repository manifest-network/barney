# Architecture

This document describes Barney's architecture from the top down: layers, data flow, and the responsibilities of each module. It complements [CLAUDE.md](CLAUDE.md) (an exhaustive file-by-file reference) and [docs/dev/primer.md](docs/dev/primer.md) (Cosmos and Manifest concepts).

## Goals

Barney is a single-page React application that:

1. Lets users deploy and manage containerized apps on Manifest Network through a conversational interface.
2. Hides blockchain mechanics behind familiar concepts (apps, credits, providers).
3. Runs entirely in the browser — there is no Barney backend. The only server-side component is an nginx reverse proxy that injects the Morpheus API key.

## High-level shape

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser (SPA)                                  │
│                                                                             │
│   ┌────────────────┐    ┌──────────────────┐    ┌────────────────────────┐  │
│   │ Chat UI / DOM  │◄──►│  Zustand AIStore │◄──►│      Tool Executor     │  │
│   │ (React 19)     │    │  + AI actions    │    │ (compositeQueries /    │  │
│   └────────────────┘    └──────────────────┘    │  compositeTransactions)│  │
│                                  ▲              └────────────┬───────────┘  │
│                                  │                           │              │
│                          ┌───────┴────────┐                  │              │
│                          │  cosmos-kit /  │◄─────────────────┘              │
│                          │  Web3Auth      │                                 │
│                          └────────┬───────┘                                 │
│                                   │                                         │
│   ┌──────────────┐   ┌────────────┴─────────────┐    ┌──────────────────┐   │
│   │ /api/morpheus│   │   manifest-mcp-core /    │    │  Provider Fetch  │   │
│   │   (proxy)    │   │   manifestjs / cosmjs    │    │     adapter      │   │
│   └──────┬───────┘   └────────────┬─────────────┘    └─────────┬────────┘   │
└──────────┼────────────────────────┼─────────────────────────────┼───────────┘
           │                        │                             │
   ┌───────▼───────┐        ┌───────▼─────────┐         ┌─────────▼────────┐
   │  Morpheus API │        │   Manifest      │         │  Provider (Fred) │
   │  (LLM)        │        │   chain (RPC +  │         │   HTTP + WS      │
   │               │        │   REST/LCD)     │         │                  │
   └───────────────┘        └─────────────────┘         └──────────────────┘
```

The **Morpheus API** never returns a manifest or a signed transaction. It returns *tool calls*. Barney executes those tool calls locally — building manifests, signing on-chain messages, uploading payloads, and polling providers — and feeds the results back to the model.

## Layers

### 1. UI layer (`src/components/`, `src/contexts/`)

React 19 components organised by concern:

- **`layout/`** — `AppShell` (top-level router), `MainLayout` (sidebar + chat split), `AppsSidebar`, `AccountSetupOverlay`.
- **`ai/`** — chat surface: `ChatPanel`, `MessageBubble`, `ConfirmationCard` (TX approval with `ManifestEditor` / `StackManifestEditor`), `ProgressCard`, `AppCard`, `CustomDomainCard`, `HelpCard`, `LogCard`.
- **`landing/`** — `LandingPage` shown when the wallet is disconnected.
- **`ui/`** — primitives (`Modal`, `Toast`, `ErrorBoundary`, `MatrixRain`, …).

Provider tree (from `src/main.tsx`):

```
ErrorBoundary
└─ ThemeProvider (next-themes — 7 themes)
   ├─ MatrixRain (renders the canvas only when theme === 'matrix'; returns null otherwise)
   └─ ChainProvider (cosmos-kit; Web3Auth wallet)
      └─ ToastProvider
         └─ AIProvider (owns the Zustand store)
            ├─ AppShell ─→ LandingPage | MainLayout
            └─ ToastContainer
```

`AppShell` syncs cosmos-kit wallet state (`clientManager`, `address`, `signing`) into the Zustand store and toggles between `LandingPage` and `MainLayout` based on `isWalletConnected`.

### 2. State layer (`src/stores/`, `src/contexts/AIContext.tsx`)

A single Zustand vanilla store (`createAIStore`) holds all AI-related state:

| Reactive state | Internal state |
|----------------|----------------|
| `messages`, `isStreaming`, `isConnected`, `settings` | `clientManager`, `address`, `signing` |
| `pendingConfirmation`, `pendingPayload`, `deployProgress` | `abortController`, `_toolCache`, `_pendingStreamUpdate`, `_rafId` |

Action implementations live in `src/stores/aiActions/`:

- `sendMessage.ts` — orchestrates the streaming chat loop with the Morpheus proxy.
- `toolExecution.ts` — `processToolCalls`, `handleToolCall`. Calls into the tool executor.
- `confirmAction.ts` — runs a previously pending TX after user approval.
- `batchDeploy.ts` — multi-app deploy orchestration.
- `streaming.ts` — RAF-coalesced streaming updates to keep React renders cheap.
- `persistence.ts` — Zustand subscriptions persisting `settings` and `messages` to localStorage.
- `utils.ts` — message ID generation, history trimming, conversion helpers.

`AIProvider` is a thin lifecycle wrapper around the store: it creates one instance per provider mount, wires up persistence subscriptions, configures health-check polling via `useVisibilityPolling`, and watches for confirmation timeouts.

### 3. AI / tool layer (`src/ai/`)

The AI layer is intentionally narrow.

- **`tools.ts`** — declarative tool definitions sent to the LLM. Defines parameter schemas and the `CONFIRMATION_TOOLS` set.
- **`systemPrompt.ts`** — base system prompt with vocabulary rules, behaviour rules, examples, and dynamically generated reference blocks (known images, known stacks, demo games).
- **`knownImages.ts`** — curated catalog of well-known Docker images (port, env defaults, health-check) and pre-built service stacks (WordPress, Ghost, Adminer-Postgres).
- **`manifest.ts`** — wraps `@manifest-network/manifest-mcp-fred`'s `buildManifest` / `mergeManifest`, adding port string normalization, password generation, payload hashing, and `BuildManifestResult`.
- **`progress.ts`** — `DeployProgress` shape (phases: `creating_lease → uploading → provisioning → ready | failed`; plus `restarting`, `updating`).
- **`streamUtils.ts`** — `processStreamWithTimeout`, `stripToolCallLeaks` (defensive filter for models that emit `[TOOL_CALLS]` markers).
- **`validation.ts`** — `AISettings` Zod schema, plus SSRF private-host classification (`isPrivateHost` via `ipaddr.js`).
- **`helpText.ts`** — content rendered by the in-app `/help` modal.
- **`toolExecutor/`** — see below.

#### `toolExecutor/` dispatch

```
executeTool(toolName, args, options, payload?)
├─ if toolName ∈ QUERY_TOOLS → executeListApps / executeAppStatus / …
├─ if toolName ∈ TX_TOOLS    → returns { requiresConfirmation: true, pendingAction }
├─ if toolName === 'cosmos_query' → executeCosmosQuery
└─ if toolName === 'cosmos_tx'    → returns { requiresConfirmation: true, … }

executeConfirmedTool(toolName, args, clientManager, options, payload?)
└─ executeConfirmedDeployApp / executeConfirmedStopApp / … / executeConfirmedBatchDeploy
```

- `compositeQueries.ts` — read-only operations that resolve immediately.
- `compositeTransactions.ts` — TX builders that *return* a confirmation request first; the actual signing happens in the `executeConfirmed*` companion when the user approves. `deploy_app`/`batch_deploy` delegate the create-lease → (set-domain) → upload → provision-poll spine to the SDK's `deployManifest` primitive (ENG-279). Deploy-path helpers live here: `buildFredAuthCtx`, `classifyLeaseChainState`, `handleDeployManifestError` (plus `deriveUrlFromConnection` in `helpers.ts`).
- `deployManifest` (imported from the `@manifest-network/manifest-sdk/deploy` facade, which re-exports mono-fred's implementation) now owns create-lease → set-domain → upload → provision-poll; barney's old hand-rolled orchestration (`transactions.ts`, then `toolExecutor/utils.ts` with `uploadPayloadToProvider`/`computePayloadHash`) is **deleted**.
- `batchRunner.ts` — concurrency-bounded batch execution with shared signing mutex; used by `requestBatchDeploy` and bulk restart. Batch deploy calls `deployManifest` directly (never wrapped in `withSign` — that deadlocks).
- `helpers.ts`, `types.ts` — shared types (`ToolResult`, `ToolExecutorOptions`, `PayloadAttachment`, `SigningContext`) and URL/port shaping helpers. ADR-036 tokens are minted by the single `createProviderAuth` instance built in `src/hooks/useManifestMCP.ts`, exposed on `SigningContext` as `providerAuth` (address-param) plus the `authTokens` address-binding adapter.

### 4. Chain & provider clients (`src/api/`)

Thin wrappers over external libraries with Barney-specific behaviour kept local.

| Module | Wraps | Adds |
|--------|-------|------|
| `bank.ts` | manifestjs / cosmjs Bank | `getBalance`, `Coin` re-export |
| `billing.ts` | manifestjs `liftedinit.billing.v1` | LCD type conversions, lease state mapping, `getCreditAccount` |
| `sku.ts` | SDK read client (`readClient.ts` `getReadClient`) + manifestjs `Unit` enum | `getProviders` / `getSKUs`; `Unit` enum and `Provider`/`SKU` type re-exports (enum fixups removed) |
| `readClient.ts` | `@manifest-network/manifest-sdk` `createManifestReadClient` | Cached query-only SDK read client (`getReadClient` / `disposeReadClient`); backs `getSKUs`/`getProviders`/`getBillingParams` |
| `tx.ts` | cosmjs Stargate signing client | `signAndBroadcast`, `buildMsg`, `fundCredit` |
| `fred.ts` | `@manifest-network/manifest-mcp-fred` | WebSocket lease event streaming, polling fallback, browser-side connection |
| `provider-api.ts` | `@manifest-network/manifest-mcp-fred` | `validateAuthTimestamp`, null-returning `getProviderHealth` |
| `providerFetchAdapter.ts` | `fetch` | Dev CORS proxy injection (`X-Proxy-Target`) and prod SSRF validation |
| `providerFetch.ts` | — | `validateProviderUrl`, `normalizeBaseUrl` |
| `morpheus.ts` | — | OpenAI-compatible SSE client; talks to `/api/morpheus/...` proxy only |
| `faucet.ts` | `@manifest-network/manifest-mcp-chain` | `faucetDripAndVerify` (drip + balance polling) |
| `queryClient.ts` | manifestjs LCD query client | Cached singleton, `lcdConvert`, `fixEnumField` |
| `config.ts` | — | `REST_URL`, `RPC_ENDPOINT`, `DENOMS`, `getDenomMetadata` |
| `utils.ts` | — | `withRetry` (exponential backoff for transient errors) |

The browser never speaks directly to the Morpheus API. All requests go through `/api/morpheus/...` — proxied by nginx in production and by the Rsbuild dev server in development. Both inject `Authorization: Bearer ${MORPHEUS_API_KEY}` server-side.

### 5. App registry (`src/registry/appRegistry.ts`)

A localStorage-backed mapping of `name → lease` scoped per wallet address (`barney-apps-{address}`). Provides a friendly identifier layer on top of raw lease UUIDs. Manifests stored in the registry are sanitized — secret-shaped env var values are scrubbed before write, and empty values trigger auto-generation on re-deploy. Per-wallet keys are isolated by address but persist forever in localStorage; only in-memory state (the tool cache and `deployProgress`) is cleared when the connected wallet changes.

## Request flows

### A. Chat message with a tool call

```
user types "Deploy redis"
   │
   ▼
ChatPanel → store.sendMessage(content)
   │
   ▼
sendMessage (aiActions/sendMessage.ts):
  1. Append user message to messages
  2. Build assistant placeholder (isStreaming: true)
  3. POST /api/morpheus/chat/completions  (SSE)
       └─→ nginx adds Authorization: Bearer …
  4. Iterate stream chunks via processStreamWithTimeout
       ├─ content   → scheduleStreamingUpdate (RAF-coalesced)
       ├─ tool_call → push to pendingToolCalls
       └─ done      → break
  5. processToolCalls(pendingToolCalls)
       └─ for each call:
            executeTool(name, args, options, payload?)
            ↳ returns ToolResult (data | requiresConfirmation | error)
  6. Append tool results as tool-role messages
  7. If iterations < AI_MAX_TOOL_ITERATIONS, continue the loop
   │
   ▼
UI updates incrementally via Zustand subscriptions
```

### B. Deploying an app (TX path)

```
executeTool('deploy_app', { image:'redis', port:'6379' }, …)
   │
   ▼
executeDeployApp (compositeTransactions.ts):
  1. Build manifest JSON (manifest.ts → fred buildManifest)
  2. Compute SHA-256 of payload
  3. Return { requiresConfirmation: true,
              confirmationMessage, pendingAction, payload }
   │
   ▼
ConfirmationCard renders ManifestEditor → user approves
   │
   ▼
store.confirmAction()
   │
   ▼
executeConfirmedTool('deploy_app', args, clientManager, options, payload)
   │
   ▼
executeConfirmedDeployApp:
  1. Rebuild payload from confirmed manifest JSON (buildPayloadFromManifest)
  2. Build ManifestDeploySpec { manifest, sku:{resolved skuUuid,providerUuid}, customDomain?, serviceName? }
  3. buildFredAuthCtx(clientManager, signing) → FredAuthCtx { query, chain, fetch, logger, providerAuth }
  4. deployManifest(ctx, spec, callOptions)          (@manifest-network/manifest-sdk/deploy)
       ├─ create lease on-chain (cosmosTx, internal)     onProgress({ phase: 'creating_lease' })
       ├─ onLeaseCreated → addApp(status:'deploying')    onProgress({ phase: 'uploading' })
       ├─ optional set-domain (atomic, before upload)
       ├─ upload manifest payload to provider (HTTP)
       └─ poll provision until ready                     onProgress({ phase: 'provisioning' })
            checkChainState → early rejected/closed detection (getLease)
  5. On throw → handleDeployManifestError (3-branch:
       pre-lease fail / ambiguous post-lease → classifyLeaseChainState / provision timeout)
  6. Shape URL from result.connection (deriveUrlFromConnection; resolveAppUrl fallback)
  7. updateApp(status:'running', url, connection, customDomains) → AppCard rendered
       onProgress({ phase: 'ready' })
```

⚠️ `deployManifest` is called **directly**, never wrapped in `signing.withSign`: it mints its own ADR-036 lease-data token through the same non-reentrant signing mutex, so wrapping it would deadlock. Serialization comes from `CosmosClientManager.withBroadcastLock` + the mutex-wrapped `signArbitrary`.

### C. First-connect account setup

```
user signs in via Web3Auth
   │
   ▼
AppShell → useAccountSetup({ address, isWalletConnected, getOfflineSignerRef })
   │
   ▼
1. Read setup state from localStorage (versionedStorage)
2. If setupCompleted=false (or stale + zero balances):
     ├─ check PWR  → faucetDripAndVerify(address, DENOMS.PWR)
     └─ check credits → fundCredit(address, 10 PWR)
   Each step retries once on failure; setup state is persisted on completion.
   │
   ▼
AccountSetupOverlay reflects { isInitialSetup, phase } state
   │
   ▼
User lands in MainLayout with funded credits.
```

Setup is skipped entirely when `PUBLIC_FAUCET_URL` is empty.

## Cross-cutting concerns

### Streaming and concurrency

- **Per-chunk timeout** — `processStreamWithTimeout` aborts the stream if no chunk arrives within `AI_STREAM_TIMEOUT_MS` (default 30 s). The inner generator cleans up via `try/finally`.
- **RAF coalescing** — `scheduleStreamingUpdate` queues the latest streamed content; `flushPendingUpdate` runs once per animation frame. This bounds React re-renders during high-rate streaming.
- **Message debouncing** — `sendMessage` debounces rapid input (`AI_MESSAGE_DEBOUNCE_MS`, 300 ms) and aborts in-flight streams when a new message is sent.
- **Visibility polling** — `useVisibilityPolling` pauses timers when the tab is hidden and fires immediately when focus returns. Health checks back off exponentially up to `AI_HEALTH_CHECK_MAX_BACKOFF × AI_HEALTH_CHECK_INTERVAL_MS`.

### Fred WebSocket lifecycle

`waitForLeaseReady` prefers WebSocket streaming, with HTTP polling as fallback (`src/api/fred.ts`). The stream lifecycle:

- **Connect** to `/v1/leases/{uuid}/events` with the ADR-036 auth token. Dev routes via `wss?://<host>/proxy-provider/...?target=<upstream>`; prod connects directly.
- **Liveness watchdog**: if no event arrives within `WS_LIVENESS_TIMEOUT_MS` (45 s; Fred pings every 30 s), the connection is treated as dead.
- **Reconnect**: up to `WS_MAX_RECONNECT_ATTEMPTS` (2) reconnects with `WS_RECONNECT_DELAY_MS` (1 s) between attempts. Each attempt re-fetches a fresh auth token via the supplied `getAuthToken` callback.
- **Permanent close codes** `{1008, 4001, 4003}` short-circuit the reconnect loop — the lease is in a state the provider won't accept further connections for.
- **Chain reconciliation**: between reconnects, the loop calls `checkChainState` to detect terminal lease states (closed / rejected / expired) and exits with `phase: 'chain_rejected'` rather than retrying forever.
- **Polling fallback**: if all WebSocket attempts fail, the loop falls back to `pollLeaseUntilReady` (HTTP polling at `FRED_POLL_INTERVAL_MS` = 3 s) until the deploy provisioning timeout fires.

### Tool result caching

Query tool results are cached per `(walletAddress, toolName, sortedArgs)` for `AI_TOOL_CACHE_TTL_MS` (10 s) up to `AI_TOOL_CACHE_MAX_SIZE` (50). When the cache hits the cap, the 10% oldest entries (by insert timestamp, minimum 5) are evicted in a single batch. The cache is cleared whenever the wallet address changes.

### Persistence

| Key | Contents |
|-----|----------|
| `barney-ai-settings` | AI settings — currently just `{ saveHistory: boolean }`. Other timeouts and limits are runtime-config env vars, not in-app settings. |
| `barney-ai-history` | Chat history (validated and sanitized on load; corrupted data cleared). Skipped when `saveHistory` is `false`. |
| `barney-apps-{address}` | App registry, scoped per wallet |
| `barney-refill-{address}` | One-shot setup completion flag (versioned; legacy name from the prior `useAutoRefill` hook) |
| `barney-theme` | next-themes selection |

`src/utils/versionedStorage.ts` provides envelope-format storage with a chained migration pipeline; new schema versions plug in without forcing data loss.

### Runtime configuration

`src/config/runtimeConfig.ts` resolves 18 client-side `PUBLIC_*` variables via:

1. `window.__RUNTIME_CONFIG__` (rendered into `/config.js` at container startup by `docker/env.sh`)
2. `import.meta.env` (build-time inlined by Rsbuild from `.env*` files)
3. Hardcoded defaults

Numeric values are clamped (`getNumericConfig` → `parsePositiveInt`). A single production build artifact serves any environment.

### Error handling

- **`logError(context, error)`** — structured logger used in every catch block. Drop-in replacement for `console.error`.
- **`withRetry(fn, opts)`** — exponential backoff for transient network errors during tool execution.
- **Error boundaries** — `ErrorBoundary` (root) and `AIErrorBoundary` (chat panel) isolate failures so a crash in chat doesn't take down the sidebar.
- **Confirmation timeouts** — pending TX approvals auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 min).

## Build and deployment

The release artifact is a Docker image (`ghcr.io/manifest-network/barney`; single-platform, currently `linux/amd64` because that's what `ubuntu-latest` provides):

1. **Stage 1** — `node:22-alpine3.21` builds the SPA (`npm ci --legacy-peer-deps && npm run build-release`). Version is stamped from `RELEASE_VERSION` (set by CI from a git tag) or, when unset, the script strips any prerelease suffix from `package.json`'s `version` and appends the short git commit hash (e.g. `0.1.0` → `0.1.0-a1b2c3d`).
2. **Stage 2** — `nginx:1.30-alpine` source-builds the Brotli dynamic modules against the matching nginx version (Alpine's prebuilt `nginx-mod-http-brotli` targets a different ABI).
3. **Stage 3** — `nginx:1.30-alpine` runtime: copies `dist/`, the Brotli modules, and `docker/{env.sh,nginx.conf.template,config.js.template}`. `env.sh` is the entrypoint.

At container startup, `env.sh`:

1. Validates `PUBLIC_MORPHEUS_URL` (required, no `?` or `#`).
2. Extracts IPv4 DNS resolvers from `/etc/resolv.conf` for nginx's `resolver` directive (with `1.1.1.1 8.8.8.8` fallback).
3. Renders `nginx.conf.template` with `MORPHEUS_API_KEY`, `PUBLIC_MORPHEUS_URL`, and `NGINX_RESOLVERS` substituted.
4. Renders `config.js.template` with all `PUBLIC_*` variables substituted.
5. Validates the rendered nginx config (`nginx -t`) before exec'ing nginx.

The `/api/morpheus/...` location uses a `proxy_pass` *variable* with `resolver … valid=30s` so nginx re-resolves the upstream IP every 30 s. Plain literal hostnames cache forever at config-load time.

See [docs/dev/deployment.md](docs/dev/deployment.md) for production guidance.

## Where to look next

| You want to … | Read |
|---------------|------|
| Understand Cosmos / Manifest concepts | [docs/dev/primer.md](docs/dev/primer.md) |
| Add a new AI tool | [docs/dev/adding-a-tool.md](docs/dev/adding-a-tool.md) |
| Add a one-click example app | [docs/dev/adding-an-example-app.md](docs/dev/adding-an-example-app.md) |
| Run, write, or debug tests | [docs/dev/testing.md](docs/dev/testing.md) |
| Deploy Barney | [docs/dev/deployment.md](docs/dev/deployment.md) |
| Understand the security model | [docs/dev/security.md](docs/dev/security.md) |
| Look up a specific file or constant | [CLAUDE.md](CLAUDE.md) |
