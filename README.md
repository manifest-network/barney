# Billing Module Tester

A simple single-page app for testing the SKU and Billing modules from [manifest-ledger](../manifest-ledger).

## Setup

```bash
bun install
bun run dev
```

## Features

The app has 4 tabs covering the full billing flow:

| Tab | Purpose |
|-----|---------|
| **Wallet & Credit** | Connect wallet, view balances, fund credit account |
| **Catalog** | Browse providers & SKUs, create new ones (authority) |
| **Leases** | Create/view/cancel leases (tenant view) |
| **Provider Dashboard** | Ack/reject leases, withdraw funds (provider view) |

## Current State

UI scaffolding with mock data. Blockchain integration not yet implemented.
