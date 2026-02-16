# Barney

Chat-primary deployment platform for [Manifest Network](https://www.manifestai.com/). Deploy and manage applications on-chain through a conversational AI interface powered by a local Ollama LLM.

## Prerequisites

- Node.js >= 20
- npm >= 10
- [Ollama](https://ollama.ai/) running locally with a model pulled (default: `llama3.2`)
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

# Ollama AI settings
PUBLIC_OLLAMA_URL=http://localhost:11434
PUBLIC_OLLAMA_MODEL=llama3.2

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
| `PUBLIC_OLLAMA_URL` | `http://localhost:11434` | Ollama LLM endpoint |
| `PUBLIC_OLLAMA_MODEL` | `llama3.2` | Default Ollama model |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | `YOUR_WEB3AUTH_CLIENT_ID` | Web3Auth client ID ([dashboard](https://dashboard.web3auth.io)) |
| `PUBLIC_WEB3AUTH_NETWORK` | `sapphire_devnet` | Web3Auth network (`sapphire_devnet`, `sapphire_mainnet`, `testnet`, `mainnet`) |
| `PUBLIC_PWR_DENOM` | Factory address | PWR token denom |

Built-in flags `import.meta.env.DEV` / `import.meta.env.PROD` remain build-time only and are unaffected.

## Scripts

```bash
npm run dev            # Start development server (Rsbuild)
npm run build          # Type check + production build
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
  contexts/        # AIContext (chat state + tool execution), ToastContext
  hooks/           # Custom hooks (persistence, MCP bridge, polling)
  registry/        # App registry (localStorage-backed name→lease mapping)
  styles/          # Global CSS with Tailwind v4 theme
  utils/           # Formatting, hashing, error helpers
```

See [CLAUDE.md](./CLAUDE.md) for detailed architecture, tool definitions, and codebase patterns.

## Architecture

### How It Works

1. **Connect** a wallet via Web3Auth social login
2. **Chat** with the AI assistant to deploy, manage, and monitor apps
3. The AI calls 15 composite tools that map to on-chain transactions and queries
4. Transaction tools require explicit user confirmation before broadcasting
5. Deploy progress is tracked in real-time through provider status polling

### AI Tool Execution

Three-layer architecture:

- **AIContext** — manages chat state, streams from Ollama, executes tools
- **useManifestMCP** — bridges cosmos-kit with the MCP browser client
- **Tool Executor** — dispatches to composite executors for queries and transactions

### Security

- **SSRF Protection**: URL validation using `ipaddr.js` to block private/internal addresses
- **Input Validation**: All user inputs and localStorage data are validated
- **Transaction Confirmation**: AI-initiated transactions require explicit user approval
- **ADR-036 Signatures**: Off-chain authentication for provider API interactions

## Tech Stack

- **React 19** with TypeScript 5.9
- **Rsbuild** — bundler (Rspack-based)
- **Tailwind CSS v4** — utility-first styling with OKLCH color theme
- **cosmos-kit** — Cosmos wallet abstraction (Web3Auth social login)
- **manifestjs** — Manifest chain client library
- **Ollama** — local LLM inference with tool calling
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
npm run build
```

Production builds are output to `dist/`.

## License

Private — All rights reserved
