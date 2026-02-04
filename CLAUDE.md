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

### Context Hierarchy

```
ChainProvider (cosmos-kit wallet abstraction)
  └─ ToastProvider (toast notifications)
      └─ AutoRefreshProvider (10s polling, pauses when tab hidden)
          └─ AIProvider (chat state, tool execution, Ollama streaming)
              └─ App (tab routing based on user role)
```

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AIContext** (`src/contexts/AIContext.tsx`) - Manages chat state, streams from Ollama, executes tools
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-mcp-browser`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Bifurcated execution:
   - **Query tools**: Execute immediately (balances, leases, providers)
   - **Transaction tools**: Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts

Tool definitions are in `src/ai/tools.ts`. The system prompt is dynamically generated from blockchain module documentation.

### Dual Transaction Paths

UI components and AI tools use separate transaction paths that both leverage manifestjs internally:

- **UI components** use `src/api/tx.ts` via `signAndBroadcast()` (cosmos-kit signer + manifestjs `getSigningLiftedinitClient`)
- **AI tool executor** uses `cosmosTx()` from `@manifest-network/manifest-mcp-browser` (an MCP server that also uses manifestjs internally)

### Wallet Integration

- cosmos-kit provides wallet abstraction (Keplr, Leap, Leap MetaMask Cosmos Snap, Cosmostation, Ledger, Web3Auth)
- `CosmosClientManager` singleton wraps the signer for MCP operations
- `signArbitrary` used for ADR-036 off-chain authentication (payload uploads to providers)

### API Layer (`src/api/`)

| Module | Purpose |
|--------|---------|
| `billing.ts` | Leases, credit accounts (custom Manifest module) |
| `sku.ts` | Provider catalog, SKU definitions |
| `bank.ts` | Cosmos SDK bank queries |
| `tx.ts` | Transaction utilities and message builders |
| `provider-api.ts` | Payload upload with ADR-036 auth |
| `ollama.ts` | LLM streaming with retry/backoff |
| `config.ts` | API endpoints, denom metadata, price formatting |
| `utils.ts` | Retry logic (`withRetry`) with exponential backoff |
| `queryClient.ts` | LCD query client factory (cached singleton) |

### Tab Components

Tabs register a fetch function with `AutoRefreshContext` on mount via `useAutoRefreshTab()`. Data flows:
```
Tab mounts → registers fetch → polls every 10s → local state → render
```

**Important:** AutoRefreshContext uses a "last one wins" model — only one fetch function is active at a time. When a new tab mounts and registers its fetch, the previous tab's fetch is replaced. This assumes only one tab is mounted at a time (tabs unmount on switch via conditional rendering in `App.tsx`).

Tabs are conditionally rendered based on `isProvider` and `isAdmin` roles checked in `App.tsx`. Each tab lives in its own subdirectory under `src/components/tabs/` (e.g., `tabs/leases/`, `tabs/catalog/`) with a barrel `index.ts` export. **Exception:** `WalletTab` does not use `useAutoRefreshTab` since it has no polling data.

## Key Patterns

- **Refs for async access**: AIContext uses refs (`clientManagerRef`, `addressRef`, `signArbitraryRef`) to avoid stale closures in streaming callbacks
- **Streaming with timeout**: `processStreamWithTimeout` prevents hung LLM connections
- **SSRF protection**: `src/ai/validation.ts` uses `ipaddr.js` to block private/internal addresses (DEV mode allows localhost for Ollama)
- **Error utilities**: Use `logError()` from `src/utils/errors.ts` instead of raw `console.error`
- **Transaction handling**: Use `useTxHandler()` hook from `src/hooks/useTxHandler.ts` for standardized transaction execution with toast notifications
- **Retry logic**: Use `withRetry()` from `src/api/utils.ts` for transient network error recovery with exponential backoff
- **Tool result caching**: Query tool results cached for 10s in AIContext to reduce redundant API calls (max 50 entries, LRU eviction)
- **LCD type conversion**: Use `lcdConvert()` from `src/api/queryClient.ts` to centralize the `as any` cast required by manifestjs `fromAmino()` converters
- **Hex encoding**: Use `toHex()` from `src/utils/hash.ts` to convert `Uint8Array` to hex strings (e.g., metaHash display). Do not inline `Array.from(...).map(b => b.toString(16)...)`.
- **Dev CORS proxy**: `provider-api.ts` routes provider API requests through `/proxy-provider` in development (rsbuild proxy), using `X-Proxy-Target` header for dynamic routing. Use `buildProviderFetchArgs()` to construct fetch URLs.

## Chain Configuration

Defined in `src/config/chain.ts`:
- Chain: `manifestlocal` (manifest-ledger-beta)
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

Environment variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_OLLAMA_URL`, `PUBLIC_OLLAMA_MODEL`, `PUBLIC_WEB3AUTH_CLIENT_ID`, `PUBLIC_WEB3AUTH_NETWORK`, `PUBLIC_PWR_DENOM`
