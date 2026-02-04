# Barney

A React-based dApp for managing cloud compute resources on the Manifest blockchain. Barney provides a user-friendly interface for leasing compute resources from providers, managing credit accounts, and interacting with the billing system.

## Features

- **Wallet Integration**: Connect with Keplr, Leap, Cosmostation, Ledger, or Web3Auth
- **Credit Management**: Fund and monitor your credit account for compute leases
- **Lease Management**: Create, monitor, and close compute resource leases
- **Provider Catalog**: Browse available compute providers and their SKUs
- **AI Assistant**: Natural language interface for blockchain operations (powered by Ollama)
- **Provider Dashboard**: For compute providers to manage their offerings

## Prerequisites

- Node.js 18+ or 20+
- npm 9+
- [Ollama](https://ollama.ai/) (optional, for AI assistant features)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd barney

# Install dependencies
npm install
```

## Development

```bash
# Start development server
npm run dev

# Run linting
npm run lint

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Build for production
npm run build

# Preview production build
npm run preview
```

## Environment Variables

Create a `.env.local` file in the project root:

```env
# Blockchain endpoints (optional, defaults shown)
PUBLIC_REST_URL=http://localhost:1317
PUBLIC_RPC_URL=http://localhost:26657

# Web3Auth social login (optional - get a client ID at https://dashboard.web3auth.io)
PUBLIC_WEB3AUTH_CLIENT_ID=your_web3auth_client_id_here
PUBLIC_WEB3AUTH_NETWORK=sapphire_devnet

# Ollama AI settings (optional)
PUBLIC_OLLAMA_URL=http://localhost:11434
PUBLIC_OLLAMA_MODEL=llama3.2
```

## Project Structure

```
src/
├── api/              # Blockchain API clients (billing, SKU, bank)
├── ai/               # AI assistant (tools, validation, prompts)
│   └── toolExecutor/ # Tool execution for AI operations
├── components/       # React components
│   ├── tabs/         # Main tab views (Wallet, Leases, Catalog, Provider)
│   ├── ai/           # AI assistant components
│   └── ui/           # Reusable UI components
├── config/           # Chain configuration and constants
├── contexts/         # React contexts (AI, AutoRefresh)
├── hooks/            # Custom React hooks
└── utils/            # Utility functions (format, hash, address, etc.)
```

## Architecture

### Blockchain Integration

- Uses `@cosmos-kit/react` for wallet management
- `@manifest-network/manifestjs` for Manifest-specific message types
- `@manifest-network/manifest-mcp-browser` for MCP (Model Context Protocol) integration

### AI Assistant

The AI assistant uses Ollama locally and can:
- Query balances and credit accounts
- List and filter leases
- Create and manage leases
- Execute arbitrary Cosmos SDK queries and transactions

All transactions require user confirmation before execution.

### Security

- **SSRF Protection**: URL validation using `ipaddr.js` to block private/internal addresses
- **Input Validation**: All user inputs and localStorage data are validated
- **Transaction Confirmation**: AI-initiated transactions require explicit user approval
- **ADR-036 Signatures**: Off-chain authentication for provider API interactions

## Testing

Tests are written with Vitest and use happy-dom for DOM simulation:

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage
```

Coverage reports are generated in the `coverage/` directory.

## Build

```bash
# Type check and build
npm run build
```

Production builds are output to `dist/`.

## Tech Stack

- **Framework**: React 19
- **Language**: TypeScript 5.9
- **Build Tool**: Rsbuild
- **Styling**: Tailwind CSS 4
- **Testing**: Vitest
- **Blockchain**: Cosmos SDK / Manifest Network

## License

Private - All rights reserved
