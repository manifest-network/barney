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

### Wallet Integration

- cosmos-kit provides wallet abstraction (Keplr, Leap, Cosmostation, Ledger, Web3Auth)
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
| `utils.ts` | Shared fetch utilities (`fetchJson`, `buildUrl`, `withRetry`) |
| `schemas.ts` | Zod schemas for API response validation |

### Tab Components

Tabs register a fetch function with `AutoRefreshContext` on mount. Data flows:
```
Tab mounts → registers fetch → polls every 10s → local state → render
```

Tabs are conditionally rendered based on `isProvider` and `isAdmin` roles checked in `App.tsx`.

## Key Patterns

- **Refs for async access**: AIContext uses refs (`clientManagerRef`, `addressRef`, `signArbitraryRef`) to avoid stale closures in streaming callbacks
- **Streaming with timeout**: `processStreamWithTimeout` prevents hung LLM connections
- **SSRF protection**: `src/ai/validation.ts` uses `ipaddr.js` to block private/internal addresses (DEV mode allows localhost for Ollama)
- **Error utilities**: Use `logError()` from `src/utils/errors.ts` instead of raw `console.error`
- **Transaction handling**: Use `useTxHandler()` hook from `src/hooks/useTxHandler.ts` for standardized transaction execution with toast notifications
- **API fetch utilities**: Use `fetchJson()` and `buildUrl()` from `src/api/utils.ts` for consistent error handling
- **API validation**: Use Zod schemas from `src/api/schemas.ts` with `fetchJson({ schema })` for runtime response validation
- **Retry logic**: Use `withRetry()` or `fetchJson({ retry: true })` for transient network error recovery with exponential backoff
- **Tool result caching**: Query tool results cached for 10s in AIContext to reduce redundant API calls (max 50 entries, LRU eviction)

## Chain Configuration

Defined in `src/config/chain.ts`:
- Chain: `manifestlocal` (manifest-ledger-beta)
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

Environment variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_OLLAMA_URL`, `PUBLIC_OLLAMA_MODEL`
