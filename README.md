# Barney - Billing Module Tester

A single-page app for testing the SKU and Billing modules from [manifest-ledger](https://github.com/liftedinit/manifest-ledger).

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A local manifest-ledger chain running on `localhost:26657` (RPC) and `localhost:1317` (REST)
- [Web3Auth](https://web3auth.io/) client ID (for social login)

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

| Variable | Description |
|----------|-------------|
| `PUBLIC_WEB3AUTH_CLIENT_ID` | Your Web3Auth client ID from [dashboard.web3auth.io](https://dashboard.web3auth.io) |
| `PUBLIC_WEB3AUTH_NETWORK` | Web3Auth network (`sapphire_devnet` or `sapphire_mainnet`) |

## Features

The app has 4 tabs covering the full billing flow:

| Tab | Purpose |
|-----|---------|
| **Wallet & Credit** | Connect wallet (Keplr, Leap, Cosmostation, Ledger, or Google via Web3Auth), view balances, fund credit account |
| **Catalog** | Browse providers & SKUs, create new ones (authority) |
| **Leases** | Create/view/cancel leases (tenant view) |
| **Provider Dashboard** | Acknowledge/reject leases, withdraw funds (provider view) |

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
