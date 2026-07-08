# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server (Rsbuild)
npm run build        # Type check + production build
npm run build-release # Stamp version + build (Docker/CI)
npm run lint         # ESLint
npm test             # Run all tests (Vitest)
npm run test:watch   # Tests in watch mode
npm run test:coverage # Tests with coverage report
npm run preview      # Preview production build locally
npm run postinstall  # Apply patches (runs automatically after npm install)
```

Run a single test file:
```bash
npx vitest run src/utils/hash.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "validateFile"
```

Tests use Vitest with `happy-dom` (not jsdom). Coverage uses the `v8` provider. See `vitest.config.ts`.

## Architecture

### UI Layout

Chat-primary deployment platform:

```
ErrorBoundary
  └─ ThemeProvider (next-themes, 7 themes registered)
      ├─ MatrixRain (renders the canvas only when theme === 'matrix'; returns null otherwise)
      └─ ChainProvider (cosmos-kit wallet abstraction)
          └─ ToastProvider (toast notifications)
              └─ AIProvider (chat state, tool execution, Morpheus streaming)
                  ├─ AppShell
                  │   ├─ AccountSetupOverlay (blocking stepper during first-connect provisioning)
                  │   ├─ LandingPage (when not connected)
                  │   └─ MainLayout (when connected)
                  │       ├─ useDnsStatusPolling (mounted here, OUTSIDE the sidebar's ErrorBoundary)
                  │       ├─ ErrorBoundary (sidebar isolation)
                  │       │   └─ AppsSidebar (wallet, credits, running apps)
                  │       ├─ AIErrorBoundary
                  │       │   └─ ChatPanel (messages, input, settings)
                  │       │       ├─ MessageBubble (per-message rendering)
                  │       │       │   └─ StreamingText (typewriter effect with link detection)
                  │       │       ├─ ProgressCard (during deploy)
                  │       │       ├─ AppCard (deploy success — wired via MessageCard `app` variant; embeds custom-domain row)
                  │       │       ├─ ConfirmationCard (TX approval; covers deploy/restart/update/stop/fund/set_custom_domain)
                  │       │       │   ├─ ManifestEditor (single-service manifest editing)
                  │       │       │   └─ StackManifestEditor (multi-service stack editing)
                  │       │       ├─ LogCard (tool result for `get_logs`)
                  │       │       ├─ CustomDomainCard (single-domain status / multi-domain consolidated / no-domain form)
                  │       │       │   └─ DomainRow (cross-cutting atom — also used by sidebar tooltip and AppCard's deploy-success row)
                  │       │       ├─ HelpCard (/help display)
                  │       │       └─ AISettings (inline settings panel)
                  │       └─ Modal (keyboard-shortcuts help, opens on `?`)
                  └─ ToastContainer (toast rendering)
```

`AppShell` (`src/components/layout/AppShell.tsx`) is the top-level router. It syncs wallet state (clientManager, address, and a `signing` SigningContext) from cosmos-kit into the AI store via `setSigning`.

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AI Store** (`src/stores/aiStore.ts`) - Zustand store managing chat state, streaming, tool execution, and wallet refs. Actions in `src/stores/aiActions/`.
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-sdk`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Dispatches to composite executors:
   - **Entry point** (`index.ts`): Contains `QUERY_TOOLS`/`TX_TOOLS` sets and `executeTool()` dispatcher
   - **Types** (`types.ts`): `ToolResult`, `ToolExecutorOptions`, `PayloadAttachment`, etc.
   - **Query tools** (`compositeQueries.ts`): Execute immediately — `list_apps`, `app_status`, `get_logs`, `get_balance`, `browse_catalog`, `lease_history`, `app_diagnostics`, `app_releases`, `request_faucet`
   - **TX tools** (`compositeTransactions.ts`): Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts — `deploy_app`, `stop_app`, `fund_credits`, `restart_app`, `update_app`, `set_custom_domain`. `deploy_app`/`batch_deploy` delegate the create-lease → (set-domain) → upload → provision-poll spine to the SDK's `deployManifest` primitive (ENG-279 deploy-path rewrite); barney keeps the plan phase, registry state machine, progress UI, and URL shaping around it. Deploy-path helpers live here: `buildFredAuthCtx` (assembles the `FredAuthCtx` deployManifest needs), `classifyLeaseChainState` + `handleDeployManifestError` (3-branch post-throw error handler)
   - **Batch runner** (`batchRunner.ts`): Shared batch execution infrastructure — `createSigningMutex`, `runBatchWithConcurrency`, `computeOverallPhase`, `summarizeBatchResult`. Used by batch deploy and batch restart. Batch deploy calls `deployManifest` **directly** under `runBatchWithConcurrency` (NOT wrapped in `withSign` — that would deadlock; see Transaction Path)
   - **Helpers** (`helpers.ts`): Shared functions — `extractPrimaryServicePorts`, `formatConnectionUrl`, `deriveUrlFromConnection` (shapes the app URL from `DeployResult.connection` with no extra round-trip)
   - **ADR-036 auth**: consolidated to a single `createProviderAuth` minter built once at the `useManifestMCP` root (`src/hooks/useManifestMCP.ts`). `authTokens` is a thin address-binding adapter over that same instance (`src/hooks/authTokensAdapter.ts`), and `providerAuth` is a required field on `SigningContext`. `deployManifest` handles payload upload + SHA-256 hashing internally, so barney's old `toolExecutor/utils.ts` (`uploadPayloadToProvider` / `computePayloadHash`) was deleted
   - **Escape hatches**: `cosmos_query` and `cosmos_tx` are handled separately (not in the QUERY_TOOLS/TX_TOOLS sets)
   - **Internal pseudo-tool**: `batch_deploy` — orchestrates multi-app deploys from the UI. Not declared in `AI_TOOLS` and never exposed to the model; routed through `executeConfirmedTool` (case `'batch_deploy'`) by the `requestBatchDeploy` AI store action (e.g. `useAI().requestBatchDeploy`)

### 17 Composite Tools

| Tool | Type | Description |
|------|------|-------------|
| `deploy_app(app_name?, size?, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?, custom_domain?, service_name?)` | TX | Deploy from attached manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image`. `custom_domain` attaches a domain in the same TX flow (single-step deploy + DNS); `service_name` picks the target service in a multi-service stack. The `size` enum is rebuilt at prompt-build time from the resolved SKU tier list (chain ∩ `PUBLIC_SKU_SPECS`); default size is the cheapest available tier (lowest normalized `$/hour` via `getCheapestTier(tiers)` in `src/api/skuTiers.ts`). The executor resolves size via `resolveSizeOrCheapest`: an omitted **or unavailable** size falls back to the cheapest tier; it returns `Tier catalog unavailable — try again in a moment.` only when the resolved tier list is empty |
| `stop_app(app_name)` | TX | Stop apps by name, comma-separated list (e.g. "redis,postgres"), or "all" to stop all running apps |
| `fund_credits(amount)` | TX | Add credits in display units |
| `restart_app(app_name)` | TX | Restart apps by name, comma-separated list, or "all" to restart all running apps |
| `update_app(app_name, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)` | TX | Update app with new manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image` |
| `set_custom_domain(app_name, custom_domain, service_name?)` | TX | Attach, change, or clear (`custom_domain=""`) a per-LeaseItem custom domain. Surfaces a `CustomDomainCard` post-broadcast with DNS status polling |
| `list_apps(state?)` | Query | List apps filtered by state (default: running) |
| `app_status(app_name)` | Query | Detailed status: registry + chain + fred. Emits a `CustomDomainCard` (single-domain status / consolidated multi-domain / no-domain form with stack picker) |
| `get_logs(app_name, tail?)` | Query | Container logs for a running app |
| `get_balance()` | Query | Credits, spending rate, time remaining |
| `browse_catalog()` | Query | Providers + SKU tiers with health checks |
| `lease_history(state?, limit?, offset?)` | Query | Paginated on-chain lease history with state filtering |
| `app_diagnostics(app_name)` | Query | Provision diagnostics: status, fail count, last error |
| `app_releases(app_name)` | Query | Release/version history for an app |
| `request_faucet()` | Query | Request free PWR (gas + credits) and MFX tokens from the faucet (24-hour cooldown per token) |
| `cosmos_query(module, subcommand, args?)` | Query | Raw chain query escape hatch |
| `cosmos_tx(module, subcommand, args)` | TX | Raw chain TX escape hatch |

Tool definitions: `src/ai/tools.ts` (static base `AI_TOOLS` + `buildAITools(tiers)` builder — the builder is what `sendMessage` ships to the model, with `deploy_app.size.enum` injected from the resolved tier list; passing `[]` omits the enum so the executor's "Tier catalog unavailable" rejection is the single failure mode). System prompt: `src/ai/systemPrompt.ts` (signature is `getSystemPrompt(address?, tiers?)` — the tier block is rendered from `tiers`). Known Docker images and stacks: `src/ai/knownImages.ts`. In-app `/help` content: `src/ai/helpText.ts` (signature is `buildHelpText(skuTiers: SkuTiersState)` — the resource-tiers table is rendered from `skuTiers.tiers`; an empty list produces phase-distinct copy: `error` → "Tier catalog unavailable: \<error\>"; `loading` → loading status row; `idle` → "not loaded yet"; defensive empty `ready` → "no tiers configured").

### Manifest Generation (`src/ai/manifest.ts`)

Thin wrappers around `@manifest-network/manifest-mcp-fred` manifest builders, adding Barney-specific behavior: port string normalization, password generation for empty env values, tmpfs/expose string splitting, SHA-256 payload hashing, and `BuildManifestResult` wrapping.

- `buildManifest(opts)` — Build single-service manifest JSON, compute hash, return `BuildManifestResult`. Delegates to fred's `buildManifest()`
- `buildStackManifest(opts)` — Build multi-service stack manifest with `{ services: {...} }` format, compute hash
- `mergeManifest(newManifest, oldManifestJson)` — Merge old manifest fields into new, graceful fallback on parse error. Delegates to fred's `mergeManifest()`
- `validateServiceName(name)` — RFC 1123 DNS label validation, returns error string or null. Wraps fred's boolean return
- `normalizePorts(port)` — Parse port string to `PortOptions`-valued ports record (Barney-local, returns `PortOptions` instead of fred's `Record<string, never>`)
- `deriveAppNameFromImage(image)` — Extract app name from Docker image ref (Barney-local, different from fred which includes tags)
- `isStackManifest(manifest)` / `parseStackManifest(json)` / `getServiceNames(manifest)` — Stack manifest utilities (Barney-local, use `{ services: {...} }` format vs fred's flat format)
- `ServiceConfig` — Type alias for `BuildManifestOptions`, used per-service in stacks

### Known Images & Stacks (`src/ai/knownImages.ts`)

- `KNOWN_IMAGES` — Readonly array of known Docker image configs with default ports, env, user, tmpfs, health_check, etc.
- `findKnownImage(imageRef)` — Lookup known image config by Docker image reference
- `KNOWN_STACKS` — Readonly array of pre-built multi-service stack configs (WordPress, Ghost, Adminer-Postgres) with `depends_on` ordering and aliases (e.g., `wp`, `pgadmin`)
- `findKnownStack(name)` — Lookup known stack by name or alias
- `generateImageReferenceForPrompt()` / `generateStackReferenceForPrompt()` — Generate reference text injected into the AI system prompt

### App Registry

`src/registry/appRegistry.ts` — localStorage-backed name→lease mapping, scoped per wallet address.

```
Key: barney-apps-{address}
AppEntry { name, leaseUuid, size, providerUuid, providerUrl, createdAt, url?, connection?, manifest?, status }
  connection? { host, fqdn?, ports?, instances?: { fqdn?, ports? }[], metadata?, services? }
AppStatus: 'deploying' | 'running' | 'stopped' | 'failed'
```

Functions: `getApps`, `getApp`, `findApp`, `getAppByLease`, `addApp`, `updateApp`, `removeApp`, `reconcileWithChain`, `validateAppName`, `sanitizeManifestForStorage`.

Name rules: lowercase, alphanumeric + hyphens, 1-32 chars, unique per wallet.

### Deploy Progress

`src/ai/progress.ts` defines `DeployProgress` with phases:
`creating_lease → uploading → provisioning → ready | failed`
Additional phases for restart/update operations: `restarting`, `updating`
The `operation` field (`'deploy' | 'restart' | 'update'`) indicates the current operation type for UI display.

Progress is reported via `onProgress` callback in `ToolExecutorOptions`, stored in the AI store as `deployProgress`, and rendered by `ProgressCard`. Batch deploys include a `batch` array with per-app progress.

### Fred API Client

`src/api/fred.ts` — Fred HTTP functions and WebSocket streaming for lease deployment status.

HTTP functions are thin wrappers with Barney's CORS proxy/SSRF `fetchFn` adapter (`src/api/providerFetchAdapter.ts`) injected. Six (`getLeaseStatus`, `getLeaseProvision`, `getLeaseInfo`, `restartLease`, `updateLease`, `getLeaseReleases`) delegate to `@manifest-network/manifest-mcp-fred`; `getLeaseLogs` is re-sourced from `@manifest-network/manifest-sdk/deploy`.

Barney-specific code that stays local:
- `pollLeaseUntilReady()` — Polling loop with `checkChainState`, `getAuthToken`, count-based `maxAttempts`
- `waitForLeaseReady()` — WebSocket-based wait with polling fallback
- `connectLeaseEvents()` — Browser WebSocket connection to Fred's `/v1/leases/{uuid}/events`

### Transaction Path

The TX path splits by tool:

- **`deploy_app` / `batch_deploy`** — delegate to the SDK's `deployManifest` primitive (imported from the `@manifest-network/manifest-sdk/deploy` facade), which runs create-lease (via `cosmosTx` internally) → optional set-domain → payload upload → provision-poll as one call. barney no longer hand-rolls this spine.
- **`stop_app` / `fund_credits` / `cosmos_tx`** — `cosmosTx()` from `@manifest-network/manifest-mcp-core` (billing `close-lease` / `fund-credit`, or the raw escape hatch). Uses manifestjs internally.
- **`update_app` / `restart_app`** — provider HTTP via `updateLease` / `restartLease` (`src/api/fred.ts` → mono fred), authenticated with an ADR-036 token; no chain TX.
- **`set_custom_domain`** — `setItemCustomDomain` from `@manifest-network/manifest-mcp-core` (standalone tool only; the deploy path attaches domains atomically *inside* `deployManifest`).

⚠️ **Never wrap `deployManifest` in `signing.withSign`.** It mints its own ADR-036 lease-data token through the same non-reentrant signing mutex, so wrapping it deadlocks (deployManifest → `providerAuth.leaseDataToken` → same mutex → circular wait). Chain-TX serialization comes from `CosmosClientManager.withBroadcastLock` plus the mutex-wrapped `signArbitrary` instead — `withSign` is for the raw `cosmosTx` tools (`stop_app`, `fund_credits`, `cosmos_tx`).

### Wallet Integration

- cosmos-kit provides wallet abstraction (Web3Auth is the only enabled wallet provider in `src/main.tsx`; Leap, Cosmostation, Ledger packages are installed but not imported)
- `CosmosClientManager` from `@manifest-network/manifest-sdk` wraps the signer for MCP operations
- `signArbitrary` (wrapped in a signing mutex) backs the single `createProviderAuth` ADR-036 minter built once at the `useManifestMCP` root. `SigningContext` exposes it as `providerAuth` (address-param, consumed by `deployManifest`'s `FredAuthCtx`) plus `authTokens`, a thin address-binding adapter over the SAME instance (`authTokensAdapter.ts`) — one `AuthTimestampTracker`, never a second minter (D2 same-lease/same-second replay guard). ADR-036 tokens authenticate payload uploads, provider connection/status queries, and fred WebSocket events

### API Layer (`src/api/`)

| Module | Purpose |
|--------|---------|
| `billing.ts` | Leases, credit accounts (custom Manifest module) |
| `sku.ts` | Provider catalog, SKU definitions |
| `skuTiers.ts` | `resolveSkuTiers(specs)` joins the chain SKU catalog with the env spec map and normalizes `basePrice` + `Unit` (PER_HOUR / PER_DAY) into `pricePerHour` display units. `hourlyPriceFromSku(sku)` is the unit→hourly converter. `getCheapestTier(tiers)` returns the lowest-`pricePerHour` entry (ties resolved by first occurrence) and is what `deploy_app` / `batch_deploy` use as the size default when the caller omits it. Returns `ResolvedSkuTier[]` ordered by env spec insertion order — that order drives the AI tool's `size.enum` and the `/help` table; the default tier is price-driven, not order-driven. Chain SKUs missing a spec entry — and spec entries missing a chain SKU — are dropped with a `logError` warning and omitted from the resolved list (config-drift policy). |
| `bank.ts` | Cosmos SDK bank queries |
| `tx.ts` | Transaction signing client and message builders for all Manifest modules (billing, SKU, provider management) |
| `provider-api.ts` | Auth helpers, health check, connection info, upload — delegates to `@manifest-network/manifest-mcp-fred` with CORS proxy/SSRF adapter. Keeps `validateAuthTimestamp` and null-returning `getProviderHealth` locally |
| `fred.ts` | Fred HTTP wrappers (delegate to mono fred) + WebSocket streaming + Barney-specific polling |
| `providerFetchAdapter.ts` | `fetchFn` adapter that injects DEV CORS proxy routing and PROD SSRF validation for mono's HTTP functions |
| `morpheus.ts` | OpenAI-compatible SSE streaming client via `/api/morpheus/` proxy |
| `config.ts` | API endpoints, denom metadata, price formatting |
| `faucet.ts` | Faucet HTTP client — token requests, drip-and-verify with balance polling |
| `providerFetch.ts` | Provider URL validation helpers (`validateProviderUrl`, `normalizeBaseUrl`), used by `fred.ts` for validating provider endpoints |
| `utils.ts` | Retry logic (`withRetry`) with exponential backoff |
| `queryClient.ts` | LCD query client factory (cached singleton) |
| `readClient.ts` | Cached query-only Manifest read client (`getReadClient` / `disposeReadClient`) built from `@manifest-network/manifest-sdk`'s `createManifestReadClient`; backs `getSKUs`/`getProviders`/`getBillingParams` and composite `get_balance` |
| `index.ts` | Barrel re-exports for API modules |

### AI Store (`src/stores/aiStore.ts`)

All AI chat state lives in a single Zustand store. Actions that are large async functions are extracted into `src/stores/aiActions/*.ts` as plain functions receiving `get`/`set`.

| Module | Purpose |
|--------|---------|
| `aiStore.ts` | Store definition, type, simple actions, tool cache, lifecycle |
| `aiActions/sendMessage.ts` | `sendMessage` streaming loop |
| `aiActions/confirmAction.ts` | `confirmAction` + `cancelAction` |
| `aiActions/batchDeploy.ts` | `requestBatchDeploy` |
| `aiActions/toolExecution.ts` | `processToolCalls`, `handleToolCall` |
| `aiActions/streaming.ts` | `scheduleStreamingUpdate`, `flushPendingUpdate` (RAF) |
| `aiActions/persistence.ts` | `loadSettings`, `loadHistory`, persistence subscriptions |
| `aiActions/skuTiers.ts` | `loadSkuTiers` / `retrySkuTiers` — boot-time SKU resolution. Parses `PUBLIC_SKU_SPECS`, calls `resolveSkuTiers()`, writes the `SkuTiersState` slice (`phase: 'idle' \| 'loading' \| 'ready' \| 'error'`, `tiers`, `denomSymbol`, `error`). Concurrent calls dedupe via the store's `_skuTiersInFlight` promise field. `retrySkuTiers` is a no-op from `ready` (consumers read `skuTiers.tiers` without phase-guarding, so transitioning `ready → loading` would leak stale tiers to in-flight chat/tool execution); from `idle`/`loading`/`error` it resets phase and re-issues the fetch. Used by the Retry button on `ChatPanel`'s tier-error banner. |
| `aiActions/stopApp.ts` | `requestStopApp` (synthesizes a `stop_app` pendingConfirmation from a UI surface) |
| `aiActions/utils.ts` | `generateMessageId`, `trimMessages`, `createAssistantMessage`, `toChatApiMessages`, `getAppRegistryAccess` |

`AIProvider` (`src/contexts/AIContext.tsx`) is a thin lifecycle wrapper that sets up persistence subscriptions, health checks, confirmation timeouts, fires `loadSkuTiers()` once on mount, and on unmount calls `store.getState().destroy()` and `disposeReadClient()` (`src/api/readClient.ts`).

**`skuTiers` slice on the store** (`aiStore.ts`): the resolved SKU tier list lives here as `SkuTiersState`. Deploy surfaces are **never disabled** by tier state — example-app buttons, sidebar re-deploy, and `ConfirmationCard` Confirm always render enabled. The executor and `ConfirmationCard` share `resolveSizeOrCheapest` (`src/api/skuTiers.ts`) so an omitted/unavailable size deploys on the cheapest tier; the card shows the resolved tier's price + specs (`formatTierSpecs`) and names any substitution (a `'cheapest-unavailable'` fallback). An empty tier list yields the executor's inline `Tier catalog unavailable` error (with a `Retry` → `retrySkuTiers`) — the single failure mode. The executor (`compositeTransactions.ts` `executeDeployApp` / `executeBatchDeploy`) reads the resolved list from `ToolExecutorOptions.tiers` rather than calling `resolveSkuTiers` itself — `confirmAction` + `batchDeploy` + `toolExecution` thread `get().skuTiers.tiers` into each call so the executor stays pure.

### Hooks (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useManifestMCP` | Bridges cosmos-kit with `@manifest-network/manifest-sdk` (builds the `CosmosClientManager` + `SigningContext` = `{ providerAuth, authTokens, withSign }`) |
| `useAutoScroll` | MutationObserver-based auto-scroll that respects user scroll position |
| `useInputHistory` | Arrow-key navigation through past chat inputs |
| `useAI` | Zustand store consumer — selects all public state/actions via `useShallow` |
| `useToast` | Context consumer hook for ToastContext |
| `useCopyToClipboard` | Clipboard copy with feedback state |
| `useAccountSetup` | One-shot sequential account setup pipeline — requests PWR from the faucet (PWR pays both gas and credits after ENG-243) and funds credits on first connect. Returns `AccountSetupState` (`isInitialSetup` + `phase`) for the `AccountSetupOverlay`. Setup data persisted to localStorage via `versionedStorage`. MFX is no longer part of the blocking flow; users who need MFX can request it via the `request_faucet` chat tool |
| `useDnsStatusPolling` | Single polling driver for custom-domain DNS state. Mounted in `MainLayout` (outside the sidebar's `ErrorBoundary`, so a sidebar render error doesn't take DNS state down with it). Iterates running apps with `customDomains` and writes per-domain `DnsStatusEntry` rows into `aiStore.dnsStatuses`. All custom-domain surfaces (sidebar dot, single-domain card, multi-domain card, AppCard's deploy-success row) read from this slice — no per-component poll loops |
| `useRegistryApps` | `useSyncExternalStore` view of the wallet's app registry, kept live via `subscribeToRegistry`. Used by `MainLayout` to feed the DNS polling driver |
| `useVisibilityPolling` | Visibility-aware polling with optional exponential backoff. Pauses on tab hidden, resumes on focus. Used by `AIProvider` (health check) and `AppsSidebar` (refresh) |

> Note: `useConfirmationFlow.test.tsx`, `useMessageManager.test.ts`, and `useToolCache.test.ts` are pure-logic test files for behaviour now living in `src/stores/aiActions/` and `src/stores/aiStore.ts`. They retain the original hook names because the underlying contracts haven't changed; no source hook file exists.

### Utility Modules (`src/utils/`)

| Module | Purpose |
|--------|---------|
| `errors.ts` | `logError()` — structured error logging (use instead of raw `console.error`) |
| `hash.ts` | `sha256()`, `sha256Hex()`, `toHex()`, `toBytes()`, `generatePassword()`, `validatePayloadSize()`, `getPayloadSize()`, `isValidMetaHash()`; `MAX_PAYLOAD_SIZE` (5KB) |
| `json.ts` | `bigIntReplacer` — `JSON.stringify` replacer that converts `bigint` values to strings to avoid serialization errors |
| `format.ts` | Amount conversion (`toBaseUnits`, `fromBaseUnits`), date/duration formatting, UUID validation |
| `fileValidation.ts` | Upload validation: size limits, allowed extensions (`.json`, `.txt` — YAML dropped; the deploy path is JSON-only since `deployManifest` JSON-parses the manifest, so `.txt` content must parse as JSON too), MIME type checks, JSON-only manifest content validation (`validateManifestContent`) |
| `pricing.ts` | BigInt-based cost calculations (`formatCostPerHour`, `calculateEstimatedCost`) to avoid integer overflow |
| `leaseState.ts` | Lease state display helpers — badge classes, labels, colors, filter mapping |
| `address.ts` | Bech32 address validation (`isValidBech32Address`) and truncation (`truncateAddress`) |
| `url.ts` | URL validation with SSRF protection (`parseHttpUrl`, `isUrlSsrfSafe`) |
| `connection.ts` | `collectInstanceUrls` — per-instance FQDN URL collection with hostname validation (`isValidFqdn`) |
| `tx.ts` | Transaction event parsing utilities (extract attribute values from TX events) |
| `versionedStorage.ts` | Versioned localStorage with schema migrations (envelope format, upgrade chain) |
| `customDomainStatus.ts` | Custom-domain status computation (`computeStatus` → `CustomDomainStatusReport`; `CustomDomainStatusKind`, DNS/HTTPS probe result types) |
| `customDomainValidation.ts` | Custom-domain FQDN validation (`validateCustomDomainFormat`, `isApex`, `isReservedSuffix`, `apexRecordKindLabel`, `APEX_WARNING`) |
| `cn.ts` | Re-exports `clsx` as `cn`: `cn('foo', condition && 'bar')` |

### Constants (`src/config/constants.ts`)

All tunable timeouts, cache sizes, and limits are centralized here. Key values:

| Constant | Value | Purpose |
|----------|-------|---------|
| `AI_STREAM_TIMEOUT_MS` | 30s | Per-chunk stream timeout (runtime-configurable) |
| `AI_CONFIRMATION_TIMEOUT_MS` | 5min | Auto-cancel pending TX confirmations (runtime-configurable) |
| `AI_DEPLOY_PROVISION_TIMEOUT_MS` | 5min | Max polling time for deploy readiness (runtime-configurable) |
| `AI_MESSAGE_DEBOUNCE_MS` | 300ms | Debounce rapid message sends |
| `AI_MAX_TOOL_ITERATIONS` | 10 | Max tool calls per message (prevents loops) (runtime-configurable) |
| `AI_MAX_MESSAGES` | 200 | Chat history memory limit (runtime-configurable) |
| `AI_TOOL_CACHE_TTL_MS` | 10s | Query result cache lifetime |
| `AI_TOOL_CACHE_MAX_SIZE` | 50 | Max cached query results |
| `AI_MAX_RETRIES` | 3 | Max retry attempts for transient network errors (runtime-configurable) |
| `AI_RETRY_BASE_DELAY_MS` | 1s | Base delay for exponential backoff |
| `AI_TOOL_API_TIMEOUT_MS` | 15s | Timeout for blockchain API calls during tool execution (runtime-configurable) |
| `AI_HEALTH_CHECK_INTERVAL_MS` | 60s | Base interval for Morpheus connectivity checks |
| `AI_HEALTH_CHECK_MAX_BACKOFF` | 8 | Max backoff multiplier (×60s = 8min ceiling) when health checks repeatedly fail |
| `AI_BATCH_DEPLOY_CONCURRENCY` | 4 | Max concurrent batch deploys (runtime-configurable) |
| `MAX_PAYLOAD_SIZE` | 5KB | Maximum file upload size (in `hash.ts`) |
| `FRED_POLL_INTERVAL_MS` | 3s | Default polling interval for Fred status checks |
| `WS_RECONNECT_DELAY_MS` | 1s | Delay before WebSocket reconnect attempt |
| `WS_MAX_RECONNECT_ATTEMPTS` | 2 | Max reconnects before falling back to polling |
| `WS_LIVENESS_TIMEOUT_MS` | 45s | WebSocket data liveness timeout (Fred pings every 30s) |
| `DNS_POLL_INTERVAL_MS` | 30s | Polling interval for browser-side DNS / HTTPS probes (`useDnsStatusPolling`) |
| `DNS_STUCK_THRESHOLD_MS` | 5min | Show "verify with dig locally" hint after sustained `pending_dns` (only when slice has no `detail`) |
| `AUTO_REFRESH_INTERVAL_MS` | 15s | Auto-refresh interval for sidebar data polling |
| `HEALTH_CHECK_TIMEOUT_MS` | 5s | Timeout for individual health-check requests |
| `POST_TX_REFETCH_DELAY_MS` | 1s | Delay before refetching state after a transaction |
| `COPY_FEEDBACK_DURATION_MS` | 2s | "Copied" feedback display duration |
| `DEFAULT_PAGE_SIZE` | 10 | Default page size for paginated lists |
| `TX_HASH_DISPLAY_LENGTH` | 16 | Truncated tx-hash display length |
| `MAX_REASON_LENGTH` | 256 | Max length for reason/description fields |
| `MAX_FILENAME_LENGTH` | 255 | Max filename length for uploads |
| `ACCOUNT_SETUP_PWR_THRESHOLD` | 5 | PWR balance below which faucet is requested (display units) |
| `ACCOUNT_SETUP_CREDIT_THRESHOLD` | 5 | Credit balance below which credits are funded (display units) |
| `ACCOUNT_SETUP_CREDIT_AMOUNT` | 10 | PWR amount funded into credits per setup pass (display units) |
| `ACCOUNT_SETUP_POLL_INTERVAL_MS` | 2s | Poll cadence for balance verification after faucet drip |
| `ACCOUNT_SETUP_POLL_TIMEOUT_MS` | 10s | Timeout for balance verification poll loop |
| `ACCOUNT_SETUP_COMPLETE_DELAY_MS` | 1.5s | Delay before dismissing account setup overlay after completion |
| `ACCOUNT_SETUP_RETRY_DELAY_MS` | 5s | Delay before retrying a failed setup step |
| `ACCOUNT_SETUP_ERROR_DELAY_MS` | 5s | Delay before dismissing the overlay when an error persists |
| `MANIFEST_NOTICE_KEY` | `'_notice'` | Key used to carry a display-only notice through manifest JSON; stripped before upload |

## Styling

- Tailwind v4 with inline `@theme` configuration in `src/index.css` (no separate `tailwind.config` file)
- Custom Manifest design system using OKLCH color space
- Fonts: Plus Jakarta Sans (headings/body), IBM Plex Mono (code)
- Use `cn()` from `src/utils/cn.ts` (re-export of `clsx`) for conditional class names
- No CSS modules or styled-components — pure Tailwind utility classes

## Key Patterns

- **Zustand store**: AI state uses a Zustand store (`src/stores/aiStore.ts`) instead of React Context + refs. Async callbacks read current state via `get()` — no ref mirrors needed. Actions are plain functions receiving `get`/`set`, extracted into `src/stores/aiActions/`. The `useAI()` hook selects all public fields via `useShallow` for backward compatibility.
- **SSRF protection**: `src/utils/url.ts` provides `parseHttpUrl` and `isUrlSsrfSafe` (DEV mode allows localhost via `isUrlSsrfSafe`); `src/ai/validation.ts` adds `isPrivateHost()` with `ipaddr.js` for IP range classification
- **Error utilities**: Use `logError()` from `src/utils/errors.ts` instead of raw `console.error`
- **Retry logic**: Use `withRetry()` from `src/api/utils.ts` for transient network error recovery with exponential backoff
- **Tool result caching**: Query tool results cached for 10s in the AI store to reduce redundant API calls (max 50 entries; when full, the 10% oldest by insert timestamp — minimum 1 — are evicted in one batch (10% of the current max 50 = 5)). Cache is scoped per wallet address and cleared on wallet change.
- **LCD type conversion**: Use `lcdConvert()` from `src/api/queryClient.ts` to centralize the `as any` cast required by manifestjs `fromAmino()` converters
- **Hex encoding**: Use `toHex()` from `src/utils/hash.ts` to convert `Uint8Array` to hex strings (e.g., metaHash display). Do not inline `Array.from(...).map(b => b.toString(16)...)`.
- **Dev CORS proxy** (`providerFetchAdapter.ts`):
  - **DEV**: routes every provider HTTP request through `/proxy-provider`, sets the `X-Proxy-Target` header to the real upstream, and the rsbuild dev proxy uses that header to route the request after passing it through `isValidProxyTarget` (cloud-metadata blocks, dangerous IP ranges, embedded credentials).
  - **PROD**: skips the dev proxy entirely; runs `parseHttpUrl` + `isUrlSsrfSafe` and fetches the URL directly (no `X-Proxy-Target`, no `/proxy-provider`).
  - Every fred/provider HTTP function from `manifest-mcp-fred` accepts a `fetchFn` parameter; Barney always passes `providerFetch` (the singleton from `providerFetchAdapter.ts`). New functions that talk to providers must do the same or they will work in dev (CORS) but break in prod (SSRF), or vice versa.
  - **WebSockets** can't set headers, so `fred.ts`'s `buildFredWsUrl` switches on `import.meta.env.DEV`: in dev it routes via `wss?://<host>/proxy-provider/...?target=<upstream>`; in prod it connects directly. The rsbuild proxy router accepts the `target` query string when `X-Proxy-Target` is absent.
- **Stream timeout**: `processStreamWithTimeout` in `src/ai/streamUtils.ts` wraps the AI stream async generator with per-chunk timeout protection (`AI_STREAM_TIMEOUT_MS`, default 30s). Prevents hung connections from blocking the UI indefinitely. The inner `withTimeout` generator ensures cleanup of the underlying generator via `finally` block.
- **Tool-call leak stripping**: `stripToolCallLeaks()` in `src/ai/streamUtils.ts` filters raw `[TOOL_CALLS]` markers that some models emit as literal text instead of structured tool_calls. Legacy safeguard from the Ollama/Mistral era, kept as defensive code for the Morpheus API.
- **Message debouncing**: The AI store debounces rapid message sends via `AI_MESSAGE_DEBOUNCE_MS` (300ms) and aborts in-flight streams when a new message is sent.
- **Chat persistence**: The AI store persists settings and chat history to localStorage (`barney-ai-settings`, `barney-ai-history`) via Zustand subscriptions. History is validated and sanitized on load; corrupted data is cleared. Streaming messages are excluded from persistence.
- **Confirmation timeout**: Pending transaction confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes) to prevent stuck UI state.
- **UI-direct store actions**: Actions that synthesize a `pendingConfirmation` from a UI surface (e.g. `requestStopApp`, `requestBatchDeploy` in `src/stores/aiActions/`) MUST gate on `pendingConfirmation !== null` before constructing the new action. Without the gate, a click while another confirmation card is open silently overwrites the store's pending action and orphans the prior tool message (`awaitingConfirmation: true`, no path to confirm/cancel — chat wedged). Matches the standard modal-overlay UX: background clicks are inert at the action layer.
- **App registry scoping**: Registry is per-wallet in localStorage. `AppShell` syncs wallet changes and clears deploy progress on disconnect.
- **Error UX boundary**: Two error surfaces by design. **Toasts** (`useToast` + `ToastContainer`) are reserved for surfaces that exist *before* the chat panel mounts — wallet connection errors (popup blocked / closed / network) in `AppShell`. Once the user is connected, all errors flow through **chat messages** (`error` field on `ChatMessage`, surfaced as inline alerts with `ERROR_PATTERNS` regex-matched "Try again" suggestion buttons in `MessageBubble.tsx`). Tool failures, deploy failures, signing rejections, payload validation, manifest parse errors all land in chat. Don't add new toasts post-connect — push errors into chat.
- **Custom-domain DNS state**: All four custom-domain surfaces (sidebar dot, deploy success pill, single-domain card, multi-domain consolidated card) read DNS status from a single source — `aiStore.dnsStatuses`. The map is populated by `useDnsStatusPolling`, mounted exactly once in `MainLayout` (deliberately outside the sidebar's `ErrorBoundary` — a sidebar render error must not take DNS state down with it). No surface runs its own polling loop. Adding a new surface means reading `dnsStatuses.get(dnsStatusKey(leaseUuid, fqdn))`, not adding another `useVisibilityPolling`.
- **SKU tier resolution**: Single source of truth is `aiStore.skuTiers` (slice produced by `loadSkuTiers`, kicked off once in `AIProvider`). The resolved tier list is chain ∩ `PUBLIC_SKU_SPECS` — chain owns SKU names + per-`Unit` prices (normalized to `$/hr` in `hourlyPriceFromSku()`), env owns CPU/RAM/disk. Session-lifetime cache — no periodic refresh. All deploy-related surfaces read from the slice: `deploy_app.size.enum` (`buildAITools(tiers)`), `/help` table (`buildHelpText(skuTiers)`), system prompt tier block (`getSystemPrompt(addr, tiers)`), `ConfirmationCard` price/specs row, executor (`compositeTransactions.ts` reads `options.tiers`). No gating: deploy surfaces (`ChatPanel` example-app buttons, `AppsSidebar` re-deploy, `ConfirmationCard` Confirm) are never disabled by tier state. The executor + `ConfirmationCard` share `resolveSizeOrCheapest` — an omitted or unavailable size resolves to the cheapest tier, and the card discloses the resolved tier's price + specs (`formatTierSpecs`) plus a substitution note when an explicitly-requested size isn't offered (`fallback === 'cheapest-unavailable'`). An empty tier list is the only hard failure: the executor returns `Tier catalog unavailable — try again in a moment.`, surfaced inline in chat with a `Retry` (`MessageBubble` `ERROR_PATTERNS` → `retrySkuTiers`). This is also the single failure mode for `buildAITools([])` omitting the `size.enum`.

### Example Apps

`src/config/exampleApps.ts` — Pre-defined app/game manifests for one-click deploys from ChatPanel.

- `EXAMPLE_APPS` array with `group: 'games' | 'apps' | 'stacks'` classification
- `findExampleByAppName(appName)` — Reverse-lookup by registry name
- `buildExampleManifest(app)` — Produces final manifest JSON. Resolution order:
  1. `manifestFactory()` — if present, builds the complete manifest dynamically (used by stacks like WordPress/Ghost that need coordinated passwords across services)
  2. `envFactory()` — if present, merges generated env vars (e.g., `generatePassword()`) into `manifest.env` (used by single-service databases)
  3. `manifest` — static manifest object used as-is (games, simple services)
- ChatPanel uses these for deploy buttons; `AppsSidebar` uses them as re-deploy fallback

## Chain Configuration

Defined in `src/config/chain.ts`:
- Chain name: `manifestlocal` (used for cosmos-kit / chain registry lookups)
- Chain ID: configurable via `PUBLIC_CHAIN_ID` (default: `manifest-ledger-beta`)
- Gas price: configurable via `PUBLIC_GAS_PRICE` (default: `0.0025factory/manifest1afk…/upwr`)
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

### Runtime Environment Variables

18 client-side `PUBLIC_*` variables use a 3-tier fallback defined in `src/config/runtimeConfig.ts`:

1. `window.__RUNTIME_CONFIG__` — set by `public/config.js` (generated at container startup by `docker/env.sh`)
2. `import.meta.env` — Rsbuild static replacement from `.env` files (requires static property access, not dynamic `import.meta.env[key]`)
3. Hardcoded defaults in `DEFAULTS` map

Consumer code imports `runtimeConfig` from `src/config/runtimeConfig.ts` — never reads `import.meta.env.PUBLIC_*` directly.

Built-in flags (`import.meta.env.DEV` / `PROD`) remain build-time and are accessed directly where needed.

Client-side variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_MORPHEUS_MODEL`, `PUBLIC_WEB3AUTH_CLIENT_ID`, `PUBLIC_WEB3AUTH_NETWORK`, `PUBLIC_PWR_DENOM`, `PUBLIC_GAS_PRICE`, `PUBLIC_CHAIN_ID`, `PUBLIC_FAUCET_URL`, `PUBLIC_AI_STREAM_TIMEOUT_MS`, `PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS`, `PUBLIC_AI_TOOL_API_TIMEOUT_MS`, `PUBLIC_AI_MAX_RETRIES`, `PUBLIC_AI_CONFIRMATION_TIMEOUT_MS`, `PUBLIC_AI_MAX_TOOL_ITERATIONS`, `PUBLIC_AI_MAX_MESSAGES`, `PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY`, `PUBLIC_SKU_SPECS`

`PUBLIC_SKU_SPECS` is special: it's a JSON-string env (e.g. `'{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}, ...}'`) parsed by `src/config/skuSpecs.ts`'s `parseSkuSpecs()` into a `Record<string, {cores, ramMB, diskGB}>`. The chain owns SKU names + prices; this env owns resource specs. The resolved tier list is the chain ∩ env intersection (see `src/api/skuTiers.ts`). Two distinct error diagnostics by source: empty / unparseable / all-entries-invalid `PUBLIC_SKU_SPECS` short-circuits synchronously to `error` with `"PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured."` (no chain call); a non-empty spec map with no chain SKU intersection lands in `error` after the chain fetch with `"No tiers available — check PUBLIC_SKU_SPECS and chain SKU catalog."` Both leave the slice with empty `tiers`; deploy buttons stay enabled, and a deploy attempt surfaces the executor's inline `Tier catalog unavailable` chat error with a `Retry` control (the `/help` table also shows the error). Tier order in the resolved list follows env spec **insertion order** and drives the AI tool's `size.enum`, the `/help` table, and the system-prompt tier block — but the **default** deploy size is the cheapest available tier (lowest `pricePerHour`, picked via `getCheapestTier(tiers)`), not `tiers[0]`. Insertion order is for presentation; price wins for defaults.

Server-side variables (never shipped to browser):
- `MORPHEUS_API_KEY` — injected by nginx (prod) or rsbuild dev proxy into upstream Morpheus API requests via `Authorization: Bearer` header
- `PUBLIC_MORPHEUS_URL` — upstream Morpheus API URL used as proxy target by nginx/rsbuild dev proxy

### Morpheus API Proxy

The client never calls the Morpheus API directly. All AI requests go through `/api/morpheus/...` (relative to origin):

- **Production**: nginx reverse-proxies `/api/morpheus/` to `$PUBLIC_MORPHEUS_URL`, injecting `Authorization: Bearer $MORPHEUS_API_KEY` server-side. Configured via `docker/nginx.conf.template` (envsubst'd at container startup by `docker/env.sh`).
- **Development**: rsbuild dev proxy does the same via `onProxyReq` callback in `rsbuild.config.ts`, reading `PUBLIC_MORPHEUS_URL` and `MORPHEUS_API_KEY` from `.env.local`.
