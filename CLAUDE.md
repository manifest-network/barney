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

## Architecture

### UI Layout

Chat-primary deployment platform:

```
ChainProvider (cosmos-kit wallet abstraction)
  └─ ToastProvider (toast notifications)
      └─ AIProvider (chat state, tool execution, Ollama streaming)
          └─ AppShell
              ├─ LandingPage (when not connected)
              └─ MainLayout (when connected)
                  ├─ AppsSidebar (wallet, credits, running apps)
                  └─ ChatPanel (monolithic: messages, input, settings)
                      ├─ MessageBubble (per-message rendering)
                      ├─ ProgressCard (during deploy)
                      ├─ AppCard (deploy success)
                      ├─ ConfirmationCard (TX approval)
                      ├─ ToolResultCard / LogCard
                      └─ AISettings (inline settings panel)
```

`AppShell` (`src/components/layout/AppShell.tsx`) is the top-level router. It syncs wallet state (clientManager, address, signArbitrary) from cosmos-kit into AIContext — replacing the old `AIAssistant` component.

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AIContext** (`src/contexts/AIContext.tsx`) - Manages chat state, streams from Ollama, executes tools
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-mcp-browser`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Dispatches to composite executors:
   - **Query tools** (`compositeQueries.ts`): Execute immediately — `list_apps`, `app_status`, `get_logs`, `get_balance`, `browse_catalog`, `lease_history`
   - **TX tools** (`compositeTransactions.ts`): Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts — `deploy_app`, `stop_app`, `fund_credits`
   - **Escape hatches**: `cosmos_query` and `cosmos_tx` are handled separately (not in the QUERY_TOOLS/TX_TOOLS sets)
   - **Internal**: `batch_deploy` — orchestrates multi-app deploys from the UI (not exposed to AI, used by `requestBatchDeploy` in AIContext)

### 11 Composite Tools

| Tool | Type | Description |
|------|------|-------------|
| `deploy_app(name?, size?)` | TX | Deploy from attached manifest. Defaults: size=micro, name from filename |
| `stop_app(name)` | TX | Stop app by name (closes lease on-chain) |
| `fund_credits(amount)` | TX | Add credits in display units |
| `list_apps(state?)` | Query | List apps filtered by state (default: running) |
| `app_status(name)` | Query | Detailed status: registry + chain + fred |
| `get_logs(name, tail?)` | Query | Container logs for a running app |
| `get_balance()` | Query | Credits, spending rate, time remaining |
| `browse_catalog()` | Query | Providers + SKU tiers with health checks |
| `lease_history(state?, limit?, offset?)` | Query | Paginated on-chain lease history with state filtering |
| `cosmos_query(module, subcommand, args?)` | Query | Raw chain query escape hatch |
| `cosmos_tx(module, subcommand, args)` | TX | Raw chain TX escape hatch |

Tool definitions: `src/ai/tools.ts`. System prompt: `src/ai/systemPrompt.ts`.

### App Registry

`src/registry/appRegistry.ts` — localStorage-backed name→lease mapping, scoped per wallet address.

```
Key: barney-apps-{address}
AppEntry { name, leaseUuid, size, providerUuid, providerUrl, createdAt, url?, connection?, manifest?, status }
```

Functions: `getApps`, `getApp`, `findApp`, `getAppByLease`, `addApp`, `updateApp`, `removeApp`, `reconcileWithChain`, `validateAppName`.

Name rules: lowercase, alphanumeric + hyphens, 1-32 chars, unique per wallet.

### Deploy Progress

`src/ai/progress.ts` defines `DeployProgress` with phases:
`checking_credits → funding → creating_lease → uploading → provisioning → ready | failed`

Progress is reported via `onProgress` callback in `ToolExecutorOptions`, stored in AIContext as `deployProgress`, and rendered by `ProgressCard`. Batch deploys include a `batch` array with per-app progress.

### Fred API Client

`src/api/fred.ts` — Polls provider's `/status/{uuid}` endpoint for deployment status. Follows `provider-api.ts` patterns (SSRF validation, dev CORS proxy, ADR-036 auth).

- `getLeaseStatus()` — Single fetch
- `pollLeaseUntilReady()` — Polling loop with configurable interval, max attempts, abort signal

### Transaction Path

AI tools use `cosmosTx()` from `@manifest-network/manifest-mcp-browser` (MCP server that uses manifestjs internally).

### Wallet Integration

- cosmos-kit provides wallet abstraction (Keplr, Leap, Leap MetaMask Cosmos Snap, Cosmostation, Ledger, Web3Auth)
- `CosmosClientManager` singleton wraps the signer for MCP operations
- `signArbitrary` used for ADR-036 off-chain authentication (payload uploads to providers, fred status queries)

### API Layer (`src/api/`)

| Module | Purpose |
|--------|---------|
| `billing.ts` | Leases, credit accounts (custom Manifest module) |
| `sku.ts` | Provider catalog, SKU definitions |
| `bank.ts` | Cosmos SDK bank queries |
| `tx.ts` | Transaction utilities and message builders |
| `provider-api.ts` | Payload upload with ADR-036 auth |
| `fred.ts` | Fred deployment status polling |
| `ollama.ts` | LLM streaming with retry/backoff |
| `config.ts` | API endpoints, denom metadata, price formatting |
| `utils.ts` | Retry logic (`withRetry`) with exponential backoff |
| `queryClient.ts` | LCD query client factory (cached singleton) |
| `index.ts` | Barrel re-exports for API modules |

## Key Patterns

- **Refs for async access**: AIContext uses refs (`clientManagerRef`, `addressRef`, `signArbitraryRef`) to avoid stale closures in streaming callbacks
- **SSRF protection**: `src/ai/validation.ts` uses `ipaddr.js` to block private/internal addresses (DEV mode allows localhost for Ollama)
- **Error utilities**: Use `logError()` from `src/utils/errors.ts` instead of raw `console.error`
- **Retry logic**: Use `withRetry()` from `src/api/utils.ts` for transient network error recovery with exponential backoff
- **Tool result caching**: Query tool results cached for 10s in AIContext to reduce redundant API calls (max 50 entries, FIFO eviction). Cache is scoped per wallet address and cleared on wallet change.
- **LCD type conversion**: Use `lcdConvert()` from `src/api/queryClient.ts` to centralize the `as any` cast required by manifestjs `fromAmino()` converters
- **Hex encoding**: Use `toHex()` from `src/utils/hash.ts` to convert `Uint8Array` to hex strings (e.g., metaHash display). Do not inline `Array.from(...).map(b => b.toString(16)...)`.
- **Dev CORS proxy**: `provider-api.ts` routes provider API requests through `/proxy-provider` in development (rsbuild proxy), using `X-Proxy-Target` header for dynamic routing. Use `buildProviderFetchArgs()` to construct fetch URLs.
- **Stream timeout**: `processStreamWithTimeout` in `src/ai/streamUtils.ts` wraps the Ollama async generator with per-chunk timeout protection (`AI_STREAM_TIMEOUT_MS`, default 30s). Prevents hung connections from blocking the UI indefinitely.
- **Message debouncing**: AIContext debounces rapid message sends via `AI_MESSAGE_DEBOUNCE_MS` (300ms) and aborts in-flight streams when a new message is sent.
- **Chat persistence**: AIContext persists settings and chat history to localStorage (`barney-ai-settings`, `barney-ai-history`). History is validated and sanitized on load; corrupted data is cleared. Streaming messages are excluded from persistence.
- **Confirmation timeout**: Pending transaction confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes) to prevent stuck UI state.
- **App registry scoping**: Registry is per-wallet in localStorage. `AppShell` syncs wallet changes and clears deploy progress on disconnect.

### Example Apps

`src/config/exampleApps.ts` — Pre-defined app/game manifests for one-click deploys from ChatPanel.

- `EXAMPLE_APPS` array with `group: 'games' | 'apps'` classification
- `findExampleByAppName(appName)` — Reverse-lookup by registry name
- `buildExampleManifest(app)` — JSON with envFactory expansion (e.g., Postgres password generation)
- ChatPanel uses these for deploy buttons; `AppsSidebar` uses them as re-deploy fallback

## Chain Configuration

Defined in `src/config/chain.ts`:
- Chain name: `manifestlocal` (used for cosmos-kit / chain registry lookups)
- Chain ID: `manifest-ledger-beta`
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

Environment variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_OLLAMA_URL`, `PUBLIC_OLLAMA_MODEL`, `PUBLIC_WEB3AUTH_CLIENT_ID`, `PUBLIC_WEB3AUTH_NETWORK`, `PUBLIC_PWR_DENOM`
