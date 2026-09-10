# Architecture

This document describes Barney's architecture from the top down: layers, data flow, and the responsibilities of each module. It complements [CLAUDE.md](CLAUDE.md) (an exhaustive file-by-file reference) and [docs/dev/primer.md](docs/dev/primer.md) (Cosmos and Manifest concepts).

## Goals

Barney is a single-page React application that:

1. Lets users deploy and manage containerized apps on Manifest Network through a conversational interface.
2. Hides blockchain mechanics behind familiar concepts (apps, credits, providers).
3. Keeps application/tool execution in the browser while a minimal server-side relay authenticates and accounts operator-funded Morpheus inference.

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
│   │   (client)   │   │   manifestjs / cosmjs    │    │     adapter      │   │
│   └──────┬───────┘   └────────────┬─────────────┘    └─────────┬────────┘   │
└──────────┼────────────────────────┼─────────────────────────────┼───────────┘
           │                        │                             │
   ┌───────▼──────────┐      ┌───────▼─────────┐         ┌─────────▼────────┐
   │ Auth + quota     │      │   Manifest      │         │  Provider (Fred) │
   │ Morpheus relay   │      │   chain (RPC +  │         │   HTTP + WS      │
   └───────┬──────────┘      │   REST/LCD)     │         │                  │
           │                 └─────────────────┘         └──────────────────┘
   ┌───────▼──────────┐
   │  Morpheus API    │
   │  (LLM)           │
   └──────────────────┘
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
├─ if toolName === 'cosmos_query' → executeCosmosQuery (read-only)
└─ otherwise → unknown tool error

executeConfirmedTool(toolName, args, options, payload?)
├─ allowlisted action + current wallet authorization + live abort signal
├─ shared typed plan validation → executeConfirmedDeployApp / executeConfirmedStopApp / …
└─ otherwise → error without signing
```

- `compositeQueries.ts` — read-only operations that resolve immediately.
- `compositeTransactions.ts` — TX builders that *return* a confirmation request first; the actual signing happens in the `executeConfirmed*` companion when the user approves. `deploy_app`/`batch_deploy` delegate the create-lease → (set-domain) → upload → provision-poll spine to the SDK's `deployManifest` primitive (ENG-279). Deploy-path helpers live here: `buildFredAuthCtx`, `classifyLeaseChainState`, `handleDeployManifestError` (plus `deriveUrlFromConnection` in `helpers.ts`).
- `deployManifest` (imported from the `@manifest-network/manifest-sdk/deploy` facade, which re-exports mono-fred's implementation) now owns create-lease → set-domain → upload → provision-poll; barney's old hand-rolled orchestration (`transactions.ts`, then `toolExecutor/utils.ts` with `uploadPayloadToProvider`/`computePayloadHash`) is **deleted**.
- `batchRunner.ts` — concurrency-bounded batch execution with shared signing mutex; used by `requestBatchDeploy` and bulk restart. Batch deploy calls `deployManifest` directly (never wrapped in `withSign` — that deadlocks).
- `helpers.ts`, `types.ts` — shared types (`ToolResult`, `ToolExecutorOptions`, `PayloadAttachment`, `SigningContext`) and URL/port shaping helpers. ADR-036 tokens are minted by the single `createProviderAuth` instance built in `src/hooks/useManifestMCP.ts`, exposed on `SigningContext` as `providerAuth` (address-param) plus the `authTokens` address-binding adapter.

#### SDK transaction boundary

Barney exposes six purpose-built mutation tools: deploy, stop, restart, update, credit funding, and custom domains. Each uses a typed high-level SDK operation after explicit user approval. Arbitrary chain transactions, bank transfers, staking, governance, and credit withdrawals are unavailable. A missing SDK capability requires a scoped SDK issue and review before a new tool can be registered; there is no raw fallback.

`transactionPlans.ts` defines the typed semantic consent schemas shared by planning and execution. Unknown action fields (including raw transaction and fee overrides) fail closed. Plans are frozen before display; batches also rebuild their canonical manifest/price plan at confirmation. The connected wallet manager enforces `MAX_TRANSACTION_GAS` before signing. `transactionFees.ts` uses the same ceiling and configured gas price to show maximum network fees, including batch totals and an optional domain transaction on deploy. Restart/update are provider operations without chain fees.

Web3Auth's `promptSign` automatically accepts SDK signature requests. Human approval therefore happens in Barney's confirmation flow; an unknown model tool cannot reach signing, and an approved action remains bound to its wallet, chain, and signer/client generations. ADR-036 authentication and fixed account-setup funding have separate policies described in [security](docs/dev/security.md#5-transaction-confirmation). See the [transaction inventory and SDK mapping](docs/dev/transaction-boundary.md).

### 4. Chain & provider clients (`src/api/`)

Thin wrappers over external libraries with Barney-specific behaviour kept local.

| Module | Wraps | Adds |
|--------|-------|------|
| `bank.ts` | manifestjs / cosmjs Bank | `getBalance`, `Coin` re-export |
| `billing.ts` | manifestjs `liftedinit.billing.v1` | LCD type conversions, lease state mapping, `getCreditAccount` |
| `sku.ts` | SDK read client (`readClient.ts` `getReadClient`) + manifestjs `Unit` enum | `getProviders` / `getSKUs`; `Unit` enum and `Provider`/`SKU` type re-exports (enum fixups removed) |
| `readClient.ts` | `@manifest-network/manifest-sdk` `createManifestReadClient` | Cached query-only SDK read client (`getReadClient` / `disposeReadClient`); backs `getSKUs`/`getProviders`/`getBillingParams` |
| `tx.ts` | — | `LeaseItemInput` type and `Unit` re-export; no transaction implementation |
| `fred.ts` | `@manifest-network/manifest-mcp-fred` | WebSocket lease event streaming, polling fallback, browser-side connection |
| `provider-api.ts` | `@manifest-network/manifest-mcp-fred` | `validateAuthTimestamp`, null-returning `getProviderHealth` |
| `providerFetchAdapter.ts` | `fetch` | Dev CORS proxy injection (`X-Proxy-Target`) and prod SSRF validation |
| `providerFetch.ts` | — | `validateProviderUrl`, `normalizeBaseUrl` |
| `morpheus.ts` | — | OpenAI-compatible SSE client; talks to `/api/morpheus/...` proxy only |
| `morpheusSession.ts` | wallet ADR-036 signer | Challenge exchange, HttpOnly-session reuse, wallet/chain headers, one safe 401 retry |
| `faucet.ts` | `@manifest-network/manifest-mcp-chain` | `faucetDripAndVerify` (drip + balance polling) |
| `queryClient.ts` | manifestjs LCD query client | Cached singleton, `lcdConvert`, `fixEnumField` |
| `config.ts` | — | `REST_URL`, `RPC_ENDPOINT`, `DENOMS`, `getDenomMetadata` |
| `utils.ts` | — | `withRetry` (exponential backoff for transient errors) |

The browser never speaks directly to the Morpheus API. In both environments it calls the same Node relay: nginx proxies to it in production and Rsbuild proxies to it in development. Only the relay verifies the wallet/chain session, reserves quota, and injects the provider credential upstream.

### 5. Paid inference relay (`server/`)

The dependency-free Node relay owns the only paid route. `auth.mjs` verifies one-time ADR-036 challenges and server-side sessions; `validation.mjs` rebuilds a bounded request; `ledger.mjs` durably reserves/settles identity and provider spend; `relay.mjs` enforces concurrency/deadlines and streams sanitized SSE; `metrics.mjs` exposes only aggregate telemetry. Nginx is a same-container front proxy and never owns the key.

### 6. App registry (`src/registry/appRegistry.ts`)

A wallet-scoped app cache (`barney-apps-{address}`) provides friendly names for lease UUIDs. `useRegistryReconciliation` and `list_apps` discover missing active/pending leases from complete paginated tenant reads. The default app listing includes both running and deploying apps; explicit state filters remain exact. `src/api/appDiscovery.ts` resolves provider URLs and SKU names. The recurring `useRegistryReconciliation` pass has an aggregate deadline of `2 * AI_TOOL_API_TIMEOUT_MS` (30s by default), covering its two sequential network stages and inter-stage processing. If that deadline expires, the hook logs the timeout and reports the entire pass as failed to the poller’s backoff policy; chain-state and custom-domain observations already applied remain. Adding another sequential stage requires revisiting that bound. `list_apps` bounds its lease and catalog reads separately, without the hook’s aggregate wrapper. Catalog lookup failures can still import authoritative chain inventory with missing metadata when discovery has not been aborted.

`useAppRecovery` separately recovers provider readiness and connection details through `hydrateDiscoveredApp`, which accepts one app per call while the user is idle. Neither chat listing nor chain reconciliation waits for provider reads or signatures. Each recovery attempt has an aggregate deadline, uses a distinct one-time credential per provider request, and yields to foreground work. Within one attempt, the status request starts after its token is minted and before connection authentication begins. A completed status verdict from that attempt is still applied if the second mint rejects or reaches the round deadline, provided the caller has not cancelled and the registry snapshot is unchanged. A mint that remains unresolved after the deadline pauses all further background attempts using the same auth-token service until it settles; waiting apps do not spend retry budget. Cancelled rounds retain their attempt budget and yield their place to other eligible apps. Unsettled or incomplete responses retry with per-app backoff, up to four attempts per unchanged app snapshot. Failed verdicts and confirmed workloads with no published endpoint retire from automatic recovery; `app_status` remains the explicit refresh path. An active chain lease alone never confirms a recovered workload is running.

localStorage is optional: failed reads/writes fall back to live per-wallet memory. Cross-tab storage events preserve unsaved local changes until a successful local write persists them and restores normal synchronization.

Failed saves are retried when a later registry operation writes the cache; reads and no-op updates do not retry. Each save replaces the whole wallet array without merging other tabs, so a later local save can overwrite another tab’s aliases or manifests. Chain discovery restores live inventory but cannot restore that metadata.

Existing aliases and sanitized manifests are preserved when available. Fresh browsers use stable lease-derived names; the current chain/provider APIs do not expose the original friendly name or manifest body. Image-based partial updates therefore require a cached manifest; otherwise the user supplies a complete replacement manifest. Closed leases remain available through `lease_history`, while local stopped-app entries are retained only in the cache. A wallet change clears registry-derived tool state and `deployProgress`; chat history remains separately scoped to wallet and chain.

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
  3. Ensure wallet/chain relay session
       └─→ one-time ADR-036 challenge when no fresh HttpOnly session exists
  4. POST /api/morpheus/chat/completions  (SSE)
       └─→ relay authenticates, reserves quota, then adds provider Authorization
  5. Iterate stream chunks via processStreamWithTimeout
       ├─ content   → scheduleStreamingUpdate (RAF-coalesced)
       ├─ tool_call → push to pendingToolCalls
       └─ done      → break
  6. processToolCalls(pendingToolCalls)
       └─ for each call:
            executeTool(name, args, options, payload?)
            ↳ returns ToolResult (data | requiresConfirmation | error)
  7. Append tool results as tool-role messages
  8. If iterations < AI_MAX_TOOL_ITERATIONS, continue the loop
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
| `barney-ai-history:v1:{chainId}:{normalizedAddress}` | Versioned chat-history envelope containing the same chain ID and normalized wallet address. Selected only after connection; invalid/mismatched data is cleared, while envelopes from a future version are preserved but not loaded. |
| `barney-apps-{address}` | App registry, scoped per wallet |
| `barney-refill-{address}` | One-shot setup completion flag (versioned; legacy name from the prior `useAutoRefill` hook) |
| `barney-theme` | next-themes selection |

The legacy global `barney-ai-history` key is discarded because its owning
wallet cannot be established safely. Wallet switches cache the old identity's
session transcript and select the new one atomically; a first visit loads that
identity's scoped storage, while switching back uses the in-memory copy.
Disconnect selects no history. `/clear` removes only the active wallet/network
key. Both clear paths are cancellation boundaries and are gated on `isStreaming`,
so neither can cancel a transaction that has already broadcast; the store action
also refuses to clear while an active transaction owns the transcript. Disabling the browser-global `saveHistory` preference stops future writes
without deleting existing keys; new messages remain isolated in the current
tab, and re-enabling it snapshots the selected wallet only when that transcript
is non-empty, so the snapshot can never delete what another tab saved.
Histories otherwise remain until explicitly cleared or the site's browser data
is cleared.

Two rules keep the session cache and localStorage from diverging. Every
automatic write re-reads the stored envelope first and refuses to touch one
stamped by a newer build, so the preservation guarantee holds even for a key
this tab last read as readable. And a `storage` event from a sibling tab evicts
the affected identity from the session cache unless it is the visible one, so
the next switch back to that wallet re-reads storage instead of painting — and
then persisting — a copy that has since been superseded. The visible transcript
is deliberately exempt: it holds live session state, so a wallet open in two
tabs stays last-writer-wins.

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

1. **Stage 1** — `node:22.19.0-alpine3.21` builds the SPA (`npm ci && npm run build-release`). Normal installation applies the wallet-signing and image-parser source patches. Version is stamped from `RELEASE_VERSION` (set by CI from a git tag) or, when unset, the script strips any prerelease suffix from `package.json`'s `version` and appends the short git commit hash (e.g. `0.1.0` → `0.1.0-a1b2c3d`).
2. **Stage 2** — `nginx:1.30-alpine` source-builds the Brotli dynamic modules against the matching nginx version (Alpine's prebuilt `nginx-mod-http-brotli` targets a different ABI).
3. **Stage 3** — `nginx:1.30-alpine` runtime: installs Node, copies `dist/`, `server/`, the Brotli modules, and `docker/{env.sh,nginx.conf.template,config.js.template}`. `env.sh` is the entrypoint.

At container startup, `env.sh`:

1. Validates `PUBLIC_MORPHEUS_URL` (required, no `?` or `#`).
2. Renders secret-free nginx configuration from only the trusted-proxy CIDR and local relay port.
3. Renders `config.js.template` with public browser variables only.
4. Validates nginx, then executes the Node supervisor.
5. The supervisor validates the complete relay policy, loads the persistent ledger, binds the relay, strips relay secrets from nginx's child environment, and starts nginx.

The image exposes nginx port 80. Relay port 8081 stays on the container/private Docker network for nginx and Prometheus; the quota ledger directory must be mounted persistently.

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
