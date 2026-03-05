# Barney

Chat-primary deployment platform for [Manifest Network](https://www.manifestai.com/). Deploy and manage applications on-chain through a conversational AI interface powered by the Morpheus API.

## Prerequisites

- Node.js >= 20
- npm >= 10
- A Morpheus API key (for AI features)
- A Manifest Network node (RPC + REST endpoints)

## Quick Start

```bash
npm install
npm run dev
```

The dev server starts at `http://localhost:3000`.

## Environment Variables

Environment variables are resolved via a 3-tier fallback (see `src/config/runtimeConfig.ts`):

1. **`window.__RUNTIME_CONFIG__`** — injected at container startup via `docker/env.sh` (production)
2. **`import.meta.env`** — inlined at build time by Rsbuild from `.env` / `.env.local` files (development)
3. **Hardcoded defaults** — safe localhost values for local development

This means a single production build artifact can be reconfigured per environment without rebuilding.

### Development

Create a `.env.local` file in the project root:

```env
# Blockchain endpoints (defaults shown)
PUBLIC_REST_URL=http://localhost:1317
PUBLIC_RPC_URL=http://localhost:26657

# Morpheus AI settings
PUBLIC_MORPHEUS_URL=https://api.mor.org/api/v1
PUBLIC_MORPHEUS_MODEL=minimax-m2.5
MORPHEUS_API_KEY=your_api_key  # Server-side only — never sent to browser

# Web3Auth social login (get a client ID at https://dashboard.web3auth.io)
PUBLIC_WEB3AUTH_CLIENT_ID=your_client_id
PUBLIC_WEB3AUTH_NETWORK=sapphire_devnet

# Custom PWR token denom (optional, defaults to local factory address)
# PUBLIC_PWR_DENOM=factory/manifest1.../upwr
```

### Production (Docker)

Set standard environment variables on the container. The `docker/env.sh` entrypoint uses `envsubst` to generate `/usr/share/nginx/html/config.js` from `docker/config.js.template` before starting nginx. Any unset variable falls through to the hardcoded default.

```bash
docker run -e PUBLIC_REST_URL=https://rest.example.com \
           -e PUBLIC_RPC_URL=https://rpc.example.com \
           -e PUBLIC_WEB3AUTH_CLIENT_ID=your_id \
           your-image
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_REST_URL` | `http://localhost:1317` | Blockchain LCD/REST endpoint |
| `PUBLIC_RPC_URL` | `http://localhost:26657` | Blockchain RPC endpoint |
| `PUBLIC_MORPHEUS_URL` | `https://api.mor.org/api/v1` | Morpheus API endpoint (server-side proxy target) |
| `PUBLIC_MORPHEUS_MODEL` | `minimax-m2.5` | Morpheus model |
| `MORPHEUS_API_KEY` | _(empty)_ | Morpheus API key — server-side only, injected by nginx proxy |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | `YOUR_WEB3AUTH_CLIENT_ID` | Web3Auth client ID ([dashboard](https://dashboard.web3auth.io)) |
| `PUBLIC_WEB3AUTH_NETWORK` | `sapphire_devnet` | Web3Auth network (`sapphire_devnet`, `sapphire_mainnet`, `testnet`, `mainnet`) |
| `PUBLIC_PWR_DENOM` | Factory address | PWR token denom |
| `PUBLIC_GAS_PRICE` | `0.0025umfx` | Gas price for transaction fees |
| `PUBLIC_CHAIN_ID` | `manifest-ledger-beta` | Chain ID for cosmos-kit |
| `PUBLIC_FAUCET_URL` | _(empty)_ | Faucet endpoint URL (enables auto-refill when set) |
| `PUBLIC_AI_STREAM_TIMEOUT_MS` | `30000` | Per-chunk stream timeout, ms (max 120000) |
| `PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS` | `300000` | Deploy provisioning timeout, ms (max 600000) |
| `PUBLIC_AI_TOOL_API_TIMEOUT_MS` | `15000` | Blockchain API call timeout, ms (max 60000) |
| `PUBLIC_AI_MAX_RETRIES` | `3` | Stream retry attempts (max 10) |
| `PUBLIC_AI_CONFIRMATION_TIMEOUT_MS` | `300000` | TX confirmation auto-cancel, ms (max 600000) |
| `PUBLIC_AI_MAX_TOOL_ITERATIONS` | `10` | Tool calls per message (max 50) |
| `PUBLIC_AI_MAX_MESSAGES` | `200` | Chat history depth (max 1000) |

Built-in flags `import.meta.env.DEV` / `import.meta.env.PROD` remain build-time only and are unaffected.

## Scripts

```bash
npm run dev            # Start development server (Rsbuild)
npm run build          # Type check + production build
npm run build-release  # Stamp git hash into version + build (used by Docker/CI)
npm run lint           # ESLint
npm test               # Run all tests (Vitest)
npm run test:watch     # Tests in watch mode
npm run test:coverage  # Tests with coverage report
npm run preview        # Preview production build locally
```

Run a single test file:

```bash
npx vitest run src/utils/hash.test.ts
```

## Project Structure

```
src/
  ai/              # LLM integration: tools, system prompt, streaming, validation
    toolExecutor/  # Tool dispatch (queries, transactions, escape hatches)
  api/             # Chain + provider API clients (billing, bank, SKU, fred)
  components/
    ai/            # Chat UI: messages, cards, settings
    landing/       # Landing page (pre-connect)
    layout/        # AppShell, MainLayout, sidebar
    ui/            # Reusable UI components
  config/          # Chain config, constants, example apps
  contexts/        # AIContext (lifecycle wrapper), ToastContext
  stores/          # Zustand stores (aiStore: chat state, tool execution, streaming)
  hooks/           # Custom hooks (persistence, MCP bridge, polling)
  registry/        # App registry (localStorage-backed name→lease mapping)
  styles/          # Global CSS with Tailwind v4 theme
  utils/           # Formatting, hashing, error helpers
```

See [CLAUDE.md](./CLAUDE.md) for detailed architecture, tool definitions, and codebase patterns.

## Architecture

### How It Works

1. **Connect** a wallet via Web3Auth social login
2. **Auto-refill** — on connect and every 60 seconds, the `useAutoRefill` hook checks MFX, PWR, and credit balances. When below threshold it requests faucet tokens and auto-funds credits (faucet-enabled deployments only; cooldowns prevent excessive requests)
3. **Chat** with the AI assistant to deploy, manage, and monitor apps
4. The AI calls 16 composite tools that map to on-chain transactions and queries
5. AI-initiated transaction tools require explicit user confirmation before broadcasting. The `useAutoRefill` background funding (`fundCredit`) is the sole exception — it runs automatically with small fixed amounts, gated by balance thresholds and cooldown timers
6. Deploy progress is tracked in real-time through provider status polling

### AI Tool Execution

Three-layer architecture:

- **AI Store** (Zustand) — manages chat state, streams from Morpheus API, executes tools
- **useManifestMCP** — bridges cosmos-kit with the MCP browser client
- **Tool Executor** — dispatches to composite executors for queries and transactions

### Security

- **SSRF Protection**: URL validation using `ipaddr.js` to block private/internal addresses
- **Input Validation**: All user inputs and localStorage data are validated
- **Transaction Confirmation**: AI-initiated transactions require explicit user approval. The sole exception is `useAutoRefill`, which auto-funds small credit amounts when balances drop below thresholds (faucet-gated, cooldown-protected)
- **ADR-036 Signatures**: Off-chain authentication for provider API interactions

## Tech Stack

- **React 19** with TypeScript 5.9
- **Rsbuild** — bundler (Rspack-based)
- **Tailwind CSS v4** — utility-first styling with OKLCH color theme
- **cosmos-kit** — Cosmos wallet abstraction (Web3Auth social login)
- **manifestjs** — Manifest chain client library
- **Morpheus API** — OpenAI-compatible LLM inference with tool calling
- **Vitest** + happy-dom — test runner
- **Lucide React** — icons

## Testing

```bash
npm test                # Run all tests
npm run test:coverage   # With coverage report
```

Coverage reports are generated in the `coverage/` directory. Tests use happy-dom for DOM simulation and run via Vitest.

## Build

```bash
npm run build          # local development
npm run build-release  # Docker/CI — appends git commit hash to version
```

Production builds are output to `dist/`. The `build-release` script runs `scripts/update-version.js` to stamp the short git commit hash into `package.json` version (e.g. `0.0.0-a1b2c3d`) before building, so the deployed UI displays the exact commit.

## License

Private — All rights reserved
