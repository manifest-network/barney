# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server (Rsbuild)
npm run build        # Type check + production build
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
  └─ ThemeProvider (next-themes, multi-theme support)
      ├─ MatrixRain (animated background, matrix theme only)
      └─ ChainProvider (cosmos-kit wallet abstraction)
          └─ ToastProvider (toast notifications)
              └─ AIProvider (chat state, tool execution, Ollama streaming)
                  ├─ AppShell
                  │   ├─ LandingPage (when not connected)
                  │   └─ MainLayout (when connected)
                  │       ├─ ErrorBoundary (sidebar isolation)
                  │       │   └─ AppsSidebar (wallet, credits, running apps)
                  │       ├─ Modal (mobile sidebar overlay)
                  │       └─ AIErrorBoundary
                  │           └─ ChatPanel (messages, input, settings)
                  │               ├─ MessageBubble (per-message rendering)
                  │               │   └─ StreamingText (typewriter effect with link detection)
                  │               ├─ ProgressCard (during deploy)
                  │               ├─ AppCard (deploy success)
                  │               ├─ ConfirmationCard (TX approval)
                  │               │   ├─ ManifestEditor (single-service manifest editing)
                  │               │   └─ StackManifestEditor (multi-service stack editing)
                  │               ├─ ToolResultCard / LogCard
                  │               ├─ HelpCard (/help display)
                  │               └─ AISettings (inline settings panel)
                  └─ ToastContainer (toast rendering)
```

`AppShell` (`src/components/layout/AppShell.tsx`) is the top-level router. It syncs wallet state (clientManager, address, signArbitrary) from cosmos-kit into AIContext.

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AI Store** (`src/stores/aiStore.ts`) - Zustand store managing chat state, streaming, tool execution, and wallet refs. Actions in `src/stores/aiActions/`.
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-mcp-browser`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Dispatches to composite executors:
   - **Query tools** (`compositeQueries.ts`): Execute immediately — `list_apps`, `app_status`, `get_logs`, `get_balance`, `browse_catalog`, `lease_history`, `app_diagnostics`, `app_releases`
   - **TX tools** (`compositeTransactions.ts`): Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts — `deploy_app`, `stop_app`, `fund_credits`, `restart_app`, `update_app`
   - **Helpers** (`helpers.ts`): Shared functions — `extractPrimaryServicePorts`, `formatConnectionUrl`, `collectInstanceUrls`
   - **Escape hatches**: `cosmos_query` and `cosmos_tx` are handled separately (not in the QUERY_TOOLS/TX_TOOLS sets)
   - **Internal**: `batch_deploy` — orchestrates multi-app deploys from the UI (not exposed to AI, used by `requestBatchDeploy` in AIContext)

### 15 Composite Tools

| Tool | Type | Description |
|------|------|-------------|
| `deploy_app(app_name?, size?, image?, port?, env?, user?, tmpfs?, command?, args?, storage?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)` | TX | Deploy from attached manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image`. Defaults: size=micro, name from filename/image |
| `stop_app(app_name)` | TX | Stop app by name, or "all" to stop all running apps |
| `fund_credits(amount)` | TX | Add credits in display units |
| `restart_app(app_name)` | TX | Restart a running app |
| `update_app(app_name, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)` | TX | Update app with new manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image` |
| `list_apps(state?)` | Query | List apps filtered by state (default: running) |
| `app_status(app_name)` | Query | Detailed status: registry + chain + fred |
| `get_logs(app_name, tail?)` | Query | Container logs for a running app |
| `get_balance()` | Query | Credits, spending rate, time remaining |
| `browse_catalog()` | Query | Providers + SKU tiers with health checks |
| `lease_history(state?, limit?, offset?)` | Query | Paginated on-chain lease history with state filtering |
| `app_diagnostics(app_name)` | Query | Provision diagnostics: status, fail count, last error |
| `app_releases(app_name)` | Query | Release/version history for an app |
| `cosmos_query(module, subcommand, args?)` | Query | Raw chain query escape hatch |
| `cosmos_tx(module, subcommand, args)` | TX | Raw chain TX escape hatch |

Tool definitions: `src/ai/tools.ts`. System prompt: `src/ai/systemPrompt.ts`. Known Docker images and stacks: `src/ai/knownImages.ts`.

### Manifest Generation (`src/ai/manifest.ts`)

Builds Docker Compose-style JSON manifests for single-service and multi-service (stack) deploys.

- `buildManifest(opts)` — Build single-service manifest JSON from image, port, env, user, tmpfs, command, args, health_check, etc.
- `buildStackManifest(opts)` — Build multi-service stack manifest with a `services` map of `ServiceConfig` entries
- `mergeManifest(newManifest, oldManifestJson)` — Merge new manifest over old, preserving env, ports, labels (merged with override), user, tmpfs, command, args, health_check, stop_grace_period, init, expose, depends_on (carried forward if not specified in new). Single-service manifests only (stack updates use full manifest replacement)
- `validateServiceName(name)` — RFC 1123 DNS label validation (1-63 chars, lowercase alphanumeric + hyphens)
- `isStackManifest(manifest)` / `parseStackManifest(json)` / `getServiceNames(manifest)` — Stack manifest detection and parsing utilities
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
  connection? { host, fqdn?, ports?, instances?: { fqdn? }[], metadata?, services? }
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

`src/api/fred.ts` — Polls provider's `/status/{uuid}` endpoint for deployment status. Follows `provider-api.ts` patterns (SSRF validation, dev CORS proxy, ADR-036 auth).

- `getLeaseStatus()` — Single fetch
- `pollLeaseUntilReady()` — Polling loop with configurable interval, max attempts, abort signal
- `waitForLeaseReady()` — WebSocket-based wait with polling fallback for deploy readiness
- `connectLeaseEvents()` — WebSocket connection to Fred's `/v1/leases/{uuid}/events` endpoint for real-time lease updates
- `getLeaseLogs()` — Fetch container logs for a running lease
- `getLeaseProvision()` — Fetch provision status
- `getLeaseInfo()` — Fetch connection details (ports, URLs)
- `restartLease()` — Restart a running lease
- `updateLease()` — Update a lease with a new manifest payload
- `getLeaseReleases()` — Fetch release/version history for a lease

### Transaction Path

AI tools use `cosmosTx()` from `@manifest-network/manifest-mcp-browser` (MCP server that uses manifestjs internally).

### Wallet Integration

- cosmos-kit provides wallet abstraction (Web3Auth and Keplr are enabled in `src/main.tsx`; Leap, Cosmostation, Ledger packages are installed but not imported)
- `CosmosClientManager` singleton wraps the signer for MCP operations
- `signArbitrary` used for ADR-036 off-chain authentication (payload uploads to providers, fred status queries)

### API Layer (`src/api/`)

| Module | Purpose |
|--------|---------|
| `billing.ts` | Leases, credit accounts (custom Manifest module) |
| `sku.ts` | Provider catalog, SKU definitions |
| `bank.ts` | Cosmos SDK bank queries |
| `tx.ts` | Transaction signing client and message builders for all Manifest modules (billing, SKU, provider management) |
| `provider-api.ts` | Payload upload with ADR-036 auth |
| `fred.ts` | Fred deployment status polling + WebSocket streaming |
| `ollama.ts` | LLM streaming with retry/backoff |
| `config.ts` | API endpoints, denom metadata, price formatting |
| `utils.ts` | Retry logic (`withRetry`) with exponential backoff |
| `queryClient.ts` | LCD query client factory (cached singleton) |
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
| `aiActions/utils.ts` | `generateMessageId`, `trimMessages`, `createAssistantMessage`, `toOllamaMessages`, `getAppRegistryAccess` |

`AIProvider` (`src/contexts/AIContext.tsx`) is a thin lifecycle wrapper that sets up persistence subscriptions, health checks, confirmation timeouts, and calls `store.getState().destroy()` on unmount.

### Hooks (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useManifestMCP` | Bridges cosmos-kit with `@manifest-network/manifest-mcp-browser` |
| `useAutoScroll` | MutationObserver-based auto-scroll that respects user scroll position |
| `useInputHistory` | Arrow-key navigation through past chat inputs |
| `useAI` | Zustand store consumer — selects all public state/actions via `useShallow` |
| `useToast` | Context consumer hook for ToastContext |
| `useTxHandler` | Transaction submission handler with cosmos-kit integration and toast notifications |
| `useLeaseItems` | Manages lease item state in forms (add/remove/update SKU items) |
| `useBatchSelection` | Manages batch selection state for bulk operations |
| `useCopyToClipboard` | Clipboard copy with feedback state |

### Utility Modules (`src/utils/`)

| Module | Purpose |
|--------|---------|
| `errors.ts` | `logError()` — structured error logging (use instead of raw `console.error`) |
| `hash.ts` | `sha256()`, `toHex()`, `generatePassword()` — hashing, hex encoding, password generation; `MAX_PAYLOAD_SIZE` (5KB) |
| `format.ts` | Amount conversion (`toBaseUnits`, `fromBaseUnits`), date/duration formatting, UUID validation |
| `fileValidation.ts` | Upload validation: size limits, allowed extensions (`.yaml`, `.yml`, `.json`, `.txt`), MIME type checks, manifest content validation (`validateManifestContent`), YAML service name extraction (`extractYamlServiceNames`) |
| `pricing.ts` | BigInt-based cost calculations (`formatCostPerHour`, `calculateEstimatedCost`) to avoid integer overflow |
| `leaseState.ts` | Lease state display helpers — badge classes, labels, colors, filter mapping |
| `address.ts` | Bech32 address validation (`isValidBech32Address`) and truncation (`truncateAddress`) |
| `url.ts` | URL validation with SSRF protection (`parseHttpUrl`, `isUrlSsrfSafe`) |
| `tx.ts` | Transaction event parsing utilities (extract attribute values from TX events) |
| `cn.ts` | Re-exports `clsx` as `cn`: `cn('foo', condition && 'bar')` |

### Constants (`src/config/constants.ts`)

All tunable timeouts, cache sizes, and limits are centralized here. Key values:

| Constant | Value | Purpose |
|----------|-------|---------|
| `AI_STREAM_TIMEOUT_MS` | 30s | Per-chunk stream timeout |
| `AI_CONFIRMATION_TIMEOUT_MS` | 5min | Auto-cancel pending TX confirmations |
| `AI_DEPLOY_PROVISION_TIMEOUT_MS` | 5min | Max polling time for deploy readiness |
| `AI_MESSAGE_DEBOUNCE_MS` | 300ms | Debounce rapid message sends |
| `AI_MAX_TOOL_ITERATIONS` | 10 | Max tool calls per message (prevents loops) |
| `AI_MAX_MESSAGES` | 200 | Chat history memory limit |
| `AI_TOOL_CACHE_TTL_MS` | 10s | Query result cache lifetime |
| `AI_TOOL_CACHE_MAX_SIZE` | 50 | Max cached query results |
| `AI_MAX_RETRIES` | 3 | Max retry attempts for transient network errors |
| `AI_RETRY_BASE_DELAY_MS` | 1s | Base delay for exponential backoff |
| `AI_TOOL_API_TIMEOUT_MS` | 15s | Timeout for blockchain API calls during tool execution |
| `MAX_PAYLOAD_SIZE` | 5KB | Maximum file upload size (in `hash.ts`) |
| `FRED_POLL_INTERVAL_MS` | 3s | Default polling interval for Fred status checks |
| `WS_RECONNECT_DELAY_MS` | 1s | Delay before WebSocket reconnect attempt |
| `WS_MAX_RECONNECT_ATTEMPTS` | 2 | Max reconnects before falling back to polling |
| `WS_LIVENESS_TIMEOUT_MS` | 45s | WebSocket data liveness timeout (Fred pings every 30s) |
| `STORAGE_SKU_NAME` | 'docker-small' | SKU name that supports persistent disk storage |

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
- **Tool result caching**: Query tool results cached for 10s in the AI store to reduce redundant API calls (max 50 entries, FIFO eviction). Cache is scoped per wallet address and cleared on wallet change.
- **LCD type conversion**: Use `lcdConvert()` from `src/api/queryClient.ts` to centralize the `as any` cast required by manifestjs `fromAmino()` converters
- **Hex encoding**: Use `toHex()` from `src/utils/hash.ts` to convert `Uint8Array` to hex strings (e.g., metaHash display). Do not inline `Array.from(...).map(b => b.toString(16)...)`.
- **Dev CORS proxy**: `provider-api.ts` routes provider API requests through `/proxy-provider` in development (rsbuild proxy), using `X-Proxy-Target` header for dynamic routing. Use `buildProviderFetchArgs()` to construct fetch URLs. The rsbuild proxy (`rsbuild.config.ts`) has its own SSRF validation layer (`isValidProxyTarget`) separate from runtime validation, blocking cloud metadata endpoints, dangerous IP ranges, and embedded credentials.
- **Stream timeout**: `processStreamWithTimeout` in `src/ai/streamUtils.ts` wraps the Ollama async generator with per-chunk timeout protection (`AI_STREAM_TIMEOUT_MS`, default 30s). Prevents hung connections from blocking the UI indefinitely. The inner `withTimeout` generator ensures cleanup of the underlying generator via `finally` block.
- **Tool-call leak stripping**: `stripToolCallLeaks()` in `src/ai/streamUtils.ts` filters raw `[TOOL_CALLS]` markers that some Ollama models emit as literal text instead of structured tool_calls.
- **Message debouncing**: The AI store debounces rapid message sends via `AI_MESSAGE_DEBOUNCE_MS` (300ms) and aborts in-flight streams when a new message is sent.
- **Chat persistence**: The AI store persists settings and chat history to localStorage (`barney-ai-settings`, `barney-ai-history`) via Zustand subscriptions. History is validated and sanitized on load; corrupted data is cleared. Streaming messages are excluded from persistence.
- **Confirmation timeout**: Pending transaction confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes) to prevent stuck UI state.
- **App registry scoping**: Registry is per-wallet in localStorage. `AppShell` syncs wallet changes and clears deploy progress on disconnect.

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
- Gas price: configurable via `PUBLIC_GAS_PRICE` (default: `0.0025umfx`)
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

### Runtime Environment Variables

All 9 `PUBLIC_*` variables use a 3-tier fallback defined in `src/config/runtimeConfig.ts`:

1. `window.__RUNTIME_CONFIG__` — set by `public/config.js` (generated at container startup by `docker/env.sh`)
2. `import.meta.env` — Rsbuild static replacement from `.env` files (requires static property access, not dynamic `import.meta.env[key]`)
3. Hardcoded defaults in `DEFAULTS` map

Consumer code imports `runtimeConfig` from `src/config/runtimeConfig.ts` — never reads `import.meta.env.PUBLIC_*` directly.

Built-in flags (`import.meta.env.DEV` / `PROD`) remain build-time and are accessed directly where needed.

Variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_OLLAMA_URL`, `PUBLIC_OLLAMA_MODEL`, `PUBLIC_WEB3AUTH_CLIENT_ID`, `PUBLIC_WEB3AUTH_NETWORK`, `PUBLIC_PWR_DENOM`, `PUBLIC_GAS_PRICE`, `PUBLIC_CHAIN_ID`
