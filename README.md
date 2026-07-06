# Barney

Chat-primary deployment platform for [Manifest Network](https://www.manifestai.com/). Deploy and manage containerized applications on-chain through a conversational AI interface backed by the Morpheus inference API.

## Hosted instances

| Environment | URL | Chain |
|-------------|-----|-------|
| Mainnet | <https://barney.manifest.network> | `manifest-ledger-mainnet` |
| Testnet | <https://barney.testnet.manifest.network> | `manifest-ledger-testnet` |

For local development or self-hosting, see [Quick start](#quick-start) and [Deployment](docs/dev/deployment.md).

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system architecture, request flow, layering
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — contributor onboarding
- **[CLAUDE.md](CLAUDE.md)** — codebase reference (file map, patterns, tool tables)
- **[docs/](docs/README.md)** — user and developer guides
  - User: [getting-started](docs/user/getting-started.md), [AI cookbook](docs/user/ai-cookbook.md), [manifest format](docs/user/manifest-format.md), [troubleshooting](docs/user/troubleshooting.md)
  - Developer: [primer](docs/dev/primer.md), [adding a tool](docs/dev/adding-a-tool.md), [adding an example app](docs/dev/adding-an-example-app.md), [testing](docs/dev/testing.md), [deployment](docs/dev/deployment.md), [security](docs/dev/security.md)

## Prerequisites

- Node.js >= 22.19.0
- npm >= 10
- A Morpheus API key (for AI features) — request access from [mor.org](https://mor.org)
- A reachable Manifest Network node (RPC + REST endpoints), or use the public testnet endpoints

## Quick start

```bash
git clone https://github.com/manifest-network/barney.git
cd barney
npm install --legacy-peer-deps
cp .env.example .env.local
# edit .env.local to set MORPHEUS_API_KEY (and optional overrides)
npm run dev
```

The dev server starts at <http://localhost:3000>.

> **Why `--legacy-peer-deps`?** The pinned `@cosmos-kit/react` and `@interchain-ui/react` versions declare incompatible peer ranges for React 19. The flag is required for installs to succeed and is already used by the production Docker build.

## Running with Docker

An image is published on every release tag to GHCR. This is the canonical deployment artifact. The build does not pin a target platform, so the architecture matches the CI runner — currently `linux/amd64` on `ubuntu-latest`.

```bash
docker run --rm -p 8080:80 \
  -e PUBLIC_REST_URL=https://nodes.liftedinit.tech/manifest/testnet/api \
  -e PUBLIC_RPC_URL=https://nodes.liftedinit.tech/manifest/testnet/rpc \
  -e PUBLIC_CHAIN_ID=manifest-ledger-testnet \
  -e PUBLIC_WEB3AUTH_CLIENT_ID=your_client_id \
  -e PUBLIC_MORPHEUS_URL=https://api.mor.org/api/v1 \
  -e MORPHEUS_API_KEY=your_api_key \
  ghcr.io/manifest-network/barney:latest
```

> Set `PUBLIC_CHAIN_ID=manifest-ledger-mainnet` and the corresponding mainnet RPC/REST endpoints (`https://nodes.manifest.network/manifest/{api,rpc}`) for production.

Image tags follow semver — `:latest`, `:1`, `:1.2`, `:1.2.3` — published by the [release workflow](.github/workflows/release.yml). See [docs/dev/deployment.md](docs/dev/deployment.md) for production guidance.

## What you can do

The AI assistant exposes 17 tools that map to on-chain transactions and queries. All transaction tools require an explicit user confirmation step.

| Category | Tool | Action |
|----------|------|--------|
| Deploy | `deploy_app` | Deploy from a manifest file, Docker image, or service stack |
| Manage | `stop_app`, `restart_app`, `update_app`, `set_custom_domain` | Lifecycle and custom-domain operations on running apps |
| Funding | `fund_credits`, `request_faucet` | Top up credits or request testnet tokens |
| Inspect | `list_apps`, `app_status`, `get_logs`, `app_diagnostics`, `app_releases` | App state, logs, error details, version history |
| Discover | `browse_catalog`, `lease_history`, `get_balance` | Provider catalog, past leases, account state |
| Escape hatch | `cosmos_query`, `cosmos_tx` | Raw chain operations (advanced) |

See [docs/user/ai-cookbook.md](docs/user/ai-cookbook.md) for example prompts and what each tool does, and [CLAUDE.md](CLAUDE.md) for the full parameter reference.

## Environment variables

Configuration uses a 3-tier fallback (see `src/config/runtimeConfig.ts`):

1. **`window.__RUNTIME_CONFIG__`** — injected at container startup via `docker/env.sh` (production)
2. **`import.meta.env`** — inlined at build time by Rsbuild from `.env` / `.env.local` (development)
3. **Hardcoded defaults** — safe localhost values for local development

A single production build artifact can be reconfigured per environment without rebuilding.

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

# Web3Auth social login (https://dashboard.web3auth.io)
PUBLIC_WEB3AUTH_CLIENT_ID=your_client_id
PUBLIC_WEB3AUTH_NETWORK=sapphire_devnet

# Optional: PWR token denom (defaults to local factory address)
# PUBLIC_PWR_DENOM=factory/manifest1.../upwr

# Optional: faucet endpoint (enables auto-provisioning when set)
# PUBLIC_FAUCET_URL=http://localhost:8000
```

### Production

Set environment variables on the container. The `docker/env.sh` entrypoint uses `envsubst` to render `/etc/nginx/conf.d/default.conf` (from `docker/nginx.conf.template`) and `/usr/share/nginx/html/config.js` (from `docker/config.js.template`) before starting nginx. Most `PUBLIC_*` values fall back to the hardcoded defaults in `runtimeConfig.ts` when unset, but two settings are required for the container to function: `PUBLIC_MORPHEUS_URL` (`env.sh` exits at startup if empty) and `MORPHEUS_API_KEY` (nginx returns 503 from `/api/morpheus/...` if empty).

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_REST_URL` | `http://localhost:1317` | Blockchain LCD/REST endpoint |
| `PUBLIC_RPC_URL` | `http://localhost:26657` | Blockchain RPC endpoint |
| `PUBLIC_MORPHEUS_URL` | _required_ | Morpheus API endpoint (server-side proxy target — `env.sh` fails fast if empty) |
| `PUBLIC_MORPHEUS_MODEL` | `minimax-m2.5` | Morpheus model identifier |
| `MORPHEUS_API_KEY` | _required_ | Morpheus API key — server-side only, injected by nginx as `Authorization: Bearer …` |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | `YOUR_WEB3AUTH_CLIENT_ID` | Web3Auth client ID ([dashboard](https://dashboard.web3auth.io)) |
| `PUBLIC_WEB3AUTH_NETWORK` | `sapphire_devnet` | One of `sapphire_devnet`, `sapphire_mainnet`, `testnet`, `mainnet` |
| `PUBLIC_PWR_DENOM` | local factory denom | PWR token denom |
| `PUBLIC_GAS_PRICE` | `0.0025factory/manifest1afk…/upwr` | Gas price for transaction fees |
| `PUBLIC_CHAIN_ID` | `manifest-ledger-beta` | Chain ID for cosmos-kit and signing |
| `PUBLIC_FAUCET_URL` | _(empty)_ | Faucet endpoint URL — enables account auto-provisioning when set |
| `PUBLIC_AI_STREAM_TIMEOUT_MS` | `30000` | Per-chunk stream timeout, ms (max `120000`) |
| `PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS` | `300000` | Deploy provisioning timeout, ms (max `600000`) |
| `PUBLIC_AI_TOOL_API_TIMEOUT_MS` | `15000` | Blockchain API call timeout, ms (max `60000`) |
| `PUBLIC_AI_MAX_RETRIES` | `3` | Stream retry attempts (max `10`) |
| `PUBLIC_AI_CONFIRMATION_TIMEOUT_MS` | `300000` | TX confirmation auto-cancel, ms (max `600000`) |
| `PUBLIC_AI_MAX_TOOL_ITERATIONS` | `10` | Tool calls per message (max `50`) |
| `PUBLIC_AI_MAX_MESSAGES` | `200` | Chat history depth (max `1000`) |
| `PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY` | `4` | Max concurrent batch deploys (max `10`) |

Built-in flags `import.meta.env.DEV` / `import.meta.env.PROD` remain build-time only and are not affected by runtime config.

## Scripts

```bash
npm run dev            # Start development server (Rsbuild)
npm run build          # Type-check + production build
npm run build-release  # Stamp version + build (Docker/CI)
npm run lint           # ESLint
npm test               # Run all tests (Vitest)
npm run test:watch     # Tests in watch mode
npm run test:coverage  # Tests with coverage report
npm run preview        # Preview production build locally
```

Run a single test file or pattern:

```bash
npx vitest run src/utils/hash.test.ts
npx vitest run -t "validateFile"
```

## Project structure

```
src/
  ai/              # LLM integration: tools, system prompt, manifest builders, streaming
    toolExecutor/  # Tool dispatch (queries, transactions, batch runner, escape hatches)
  api/             # Chain + provider API clients (billing, bank, sku, fred, faucet, morpheus)
  components/
    ai/            # Chat UI: messages, cards, manifest editors, settings
    landing/       # Landing page (pre-connect)
    layout/        # AppShell, MainLayout, sidebar, account-setup overlay
    ui/            # Reusable UI primitives
  config/          # Chain config, constants, runtime config, example apps
  contexts/        # AIProvider lifecycle, ToastContext
  stores/          # Zustand store (aiStore + aiActions/) — chat state, tool execution
  hooks/           # Custom hooks (account setup, MCP bridge, polling, etc.)
  registry/        # App registry (per-wallet localStorage name → lease mapping)
  utils/           # Hashing, formatting, file validation, errors, URL/SSRF, etc.
  types/           # Ambient module declarations (e.g., interchain-ui)
  __tests__/       # Cross-cutting integration tests (e.g., deployFlow)
  index.css        # Tailwind v4 inline @theme + global styles (single file, no styles/ dir)
  main.tsx         # Entry: ChainProvider + providers + AppShell
docker/            # Production runtime: env.sh, nginx.conf.template, config.js.template
patches/           # patch-package patches (applied via postinstall)
public/            # Static assets including config.js placeholder
scripts/           # Build helpers (e.g., update-version.cjs)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for layered architecture and request flow, and [CLAUDE.md](CLAUDE.md) for an exhaustive file-by-file reference.

## How it works

1. **Connect** a wallet via Web3Auth social login.
2. **Account setup** — on first connect (and only when `PUBLIC_FAUCET_URL` is configured), the `useAccountSetup` hook runs a one-shot pipeline: requests PWR from the faucet (PWR covers both gas and credits after ENG-243) and funds credits. MFX is no longer part of the blocking flow — users who need MFX request it via the `request_faucet` chat tool.
3. **Chat** with the AI to deploy, manage, and monitor apps.
4. The AI calls 17 composite tools that map to on-chain transactions and queries.
5. Transaction tools require explicit user confirmation; the manifest can be edited inline before broadcast.
6. Deploy progress is tracked in real time through provider WebSocket events with polling fallback.

## Tech stack

- **React 19** with TypeScript 5.9
- **Rsbuild** — bundler (Rspack-based)
- **Tailwind CSS v4** — utility-first styling with OKLCH theme tokens
- **cosmos-kit** — Cosmos wallet abstraction (only `@cosmos-kit/web3auth` is registered in `main.tsx`; Leap, Cosmostation, and Ledger packages are installed but not enabled)
- **manifestjs** — generated Manifest chain client
- **`@manifest-network/manifest-sdk` / `manifest-mcp-core` / `mcp-fred` / `mcp-chain`** — shared SDK + MCP libraries: the sdk barrel provides CosmosClientManager, WalletProvider, the read client, and provider auth/deploy helpers (createAuthTokens, getLeaseLogs); core handles transaction signing (cosmosTx/cosmosQuery); fred provides provider HTTP/WebSocket; chain backs the faucet
- **Morpheus API** — OpenAI-compatible LLM inference with tool calling
- **Zustand** — vanilla store for AI chat state
- **Vitest** + happy-dom — test runner
- **lucide-react** — icons

## Security highlights

- **SSRF protection** — runtime URL validation via `ipaddr.js`; rsbuild dev proxy enforces a separate validator (`isValidProxyTarget`) blocking cloud metadata, DNS-rebinding services, and dangerous IP ranges.
- **Server-side secret injection** — `MORPHEUS_API_KEY` is never shipped to the browser; nginx (prod) and the rsbuild dev proxy inject `Authorization: Bearer …` server-side.
- **Transaction confirmation** — every AI-initiated transaction requires explicit user approval. Pending confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (default 5 min).
- **Manifest sanitization** — secret-shaped env var values (`*password*`, `*token*`, `*key*`, …) are scrubbed before persisting manifests to localStorage; empty values trigger auto-generation on re-deploy.
- **CSP** — restrictive content-security policy in `index.html`. `unsafe-inline` / `unsafe-eval` are required by Web3Auth and cosmos-kit and are scoped accordingly.

See [docs/dev/security.md](docs/dev/security.md) for the threat model.

## Build

```bash
npm run build          # local build to dist/
npm run build-release  # CI build — stamps version into package.json before building
```

`build-release` runs `scripts/update-version.cjs`. With `RELEASE_VERSION` set (e.g. by CI from a git tag), it uses that exact value; otherwise it strips any prerelease suffix from `package.json`'s `version` and appends the short git commit hash (e.g. `0.1.0` → `0.1.0-a1b2c3d`).

## License

Private — all rights reserved.
