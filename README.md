# Barney - Billing Module Tester

A single-page app for testing the SKU and Billing modules from [manifest-ledger](https://github.com/liftedinit/manifest-ledger).

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A local manifest-ledger chain running on `localhost:26657` (RPC) and `localhost:1317` (REST)
- [Web3Auth](https://web3auth.io/) client ID (for social login)
- [Ollama](https://ollama.com/) (optional, for AI assistant)

## Setup

1. Copy the environment file and configure your Web3Auth client ID:
   ```bash
   cp .env.example .env.local
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PUBLIC_REST_URL` | REST API endpoint | `http://localhost:1317` |
| `PUBLIC_RPC_URL` | RPC endpoint | `http://localhost:26657` |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | Your Web3Auth client ID from [dashboard.web3auth.io](https://dashboard.web3auth.io) | — |
| `PUBLIC_WEB3AUTH_NETWORK` | Web3Auth network (`sapphire_devnet` or `sapphire_mainnet`) | `sapphire_devnet` |
| `PUBLIC_OLLAMA_URL` | Ollama endpoint URL | `http://localhost:11434` |
| `PUBLIC_OLLAMA_MODEL` | Default Ollama model for the AI assistant | `llama3.2` |

## Features

The app has 5 tabs covering the full billing flow:

| Tab | Purpose |
|-----|---------|
| **Wallet & Credit** | Connect wallet (Keplr, Leap, Cosmostation, Ledger, or Google via Web3Auth), view balances, fund credit account |
| **Catalog** | Browse providers & SKUs, create new ones (authority) |
| **Leases** | Create/view/cancel leases (tenant view) |
| **Provider Dashboard** | Acknowledge/reject leases, withdraw funds (provider view) |
| **Network Overview** | Network-wide billing statistics and lease activity (admin) |

### AI Assistant

An optional AI chat assistant (Ctrl+/) powered by [Ollama](https://ollama.com/) can execute blockchain queries and transactions through natural language. Requires a running Ollama instance with a compatible model.

## Supported Wallets

- Keplr
- Leap
- Cosmostation
- Ledger
- MetaMask (via Leap Snap)
- Google (via Web3Auth)

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start development server |
| `bun run build` | Build for production |
| `bun run preview` | Preview production build |
| `bun run lint` | Run ESLint |

## Tech Stack

- React 19
- Rsbuild
- Tailwind CSS 4
- cosmos-kit (wallet connections)
- manifestjs (chain interactions)
- Ollama (AI assistant)
