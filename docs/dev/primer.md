# Cosmos and Manifest primer

This primer is for developers new to Cosmos SDK chains or to Manifest Network. It covers just enough to make the rest of the developer docs make sense. If you've shipped a Cosmos SDK chain integration before, skim the section headings and skip to the [Manifest-specific concepts](#manifest-specific-concepts).

## Cosmos SDK in 60 seconds

Cosmos SDK chains are built from independent **modules**, each owning a chunk of state and a set of message types. The Manifest blockchain composes a small handful of standard modules (`bank`, `staking`, `auth`, `gov`) with custom modules — most notably `billing` (credit accounts and leases) and `sku` (providers and resource tiers). Module proto paths live under `liftedinit.*` in the manifestjs codegen (e.g. `liftedinit.billing.v1`, `liftedinit.sku.v1`).

A typical request flow looks like:

```
Client ──► sign Tx ──► RPC node ──► consensus / commit ──► state update ──► event log
```

Two read endpoints are commonly exposed:

- **RPC** (Tendermint/CometBFT, default port `26657`) — block headers, broadcast, subscriptions.
- **REST/LCD** (Light Client Daemon, default port `1317`) — gRPC-gateway HTTP wrappers around module queries.

Barney uses both: cosmjs's signing client talks to RPC for broadcast, and the manifestjs LCD client talks to REST for queries.

### Addresses and bech32

Cosmos addresses are bech32-encoded with a per-chain prefix. Manifest uses `manifest1...`. The same secp256k1 key produces different addresses on different chains because the prefix differs. Web3Auth derives the secp256k1 key from your social identity and Barney bech32-encodes it with the `manifest` prefix.

The slip44 coin type for Manifest is `118` (the standard Cosmos coin type), so a hardware wallet treats Manifest addresses as Cosmos-compatible.

### Coins and denominations

Balances are stored as integer `Coin` values: `{ amount: "1234567", denom: "umfx" }`. Most denoms are *micro*-denominated (the `u` prefix), with 6 decimal places.

Manifest's two denoms:

| Display | Base denom | Decimals | Purpose |
|---------|-----------|----------|---------|
| MFX | `umfx` | 6 | Gas token; pays transaction fees |
| PWR | `factory/.../upwr` | 6 | Credit token; pays for active leases |

The PWR denom uses the `tokenfactory` module, which lets a chain spawn child denoms namespaced by creator address. The local devnet PWR denom is `factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr`.

### Transactions

A Cosmos SDK transaction wraps one or more typed `Msg` objects. Each message names a module path and a payload. For Barney's most common transaction:

```ts
{
  typeUrl: '/liftedinit.billing.v1.MsgCreateLease',
  value: { tenant: '...', items: [/* SKU items */], metaHash: /* SHA-256 of manifest */ }
}
```

Barney builds messages via `manifestjs`'s generated code (`@manifest-network/manifestjs/dist/codegen/...`), signs with cosmjs's `SigningStargateClient`, and broadcasts via RPC. The signing client also handles fee estimation against the configured `GAS_PRICE`.

> **Why `buildMsg` and `lcdConvert` use `any`.** manifestjs's codegen produces `fromPartial(value: I)` overloads where `I` is an intersection like `MsgFundCredit & Record<string|number|symbol, never>`. TypeScript treats that intersection as essentially "no properties", so the compiler rejects every plausible object literal you could pass. The accepted project pattern is to type the `fromPartial` parameter as `any` inside `buildMsg` (`src/api/tx.ts`) and `lcdConvert` (`src/api/queryClient.ts`) while keeping the surrounding code typed. Don't reach for `// @ts-ignore` — use the helpers.

### ADR-036 (sign arbitrary)

ADR-036 is the Cosmos standard for *off-chain* signatures — proving address ownership without a transaction. Barney uses ADR-036 to authenticate to providers when uploading manifest payloads or querying lease status. The cosmos-kit `signArbitrary` method produces the signature; `getProviderAuthToken` (in `src/ai/toolExecutor/utils.ts`) packages it into the bearer token providers expect.

## Manifest-specific concepts

### Providers, SKUs, and the catalog

Manifest decentralises hosting. **Providers** are independent operators running **Fred**, the per-provider runtime that schedules containers and exposes an HTTP/WebSocket API. The chain holds the on-chain catalog under the `sku` module:

- `liftedinit.sku.v1.Provider` — `uuid`, `address`, `payoutAddress`, `metaHash`, `active`, `apiUrl`. (Note: there is no `name` field.)
- `liftedinit.sku.v1.SKU` — a "tier" with a price (`basePrice`), unit (`UNIT_PER_HOUR` / `UNIT_PER_DAY`), and resource description.

A typical provider exposes four standard SKU tiers: `docker-micro`, `docker-small`, `docker-medium`, `docker-large`. The hardcoded constant `STORAGE_SKU_NAME = 'docker-small'` marks the smallest tier with persistent disk; larger tiers also support disk.

`browse_catalog` (in Barney) calls `getProviders` and `getSKUs` and then health-checks each provider's API URL.

### Leases

A **lease** is a billing-and-execution agreement between a tenant (your wallet) and a provider. Conceptually:

- The tenant deposits credit (PWR) into a credit account on chain.
- A `MsgCreateLease` reserves capacity at a chosen provider with chosen SKU items.
- While the lease is `LEASE_STATE_ACTIVE`, the chain debits the credit account at the lease's per-second rate.
- The tenant uploads a manifest payload to the provider via HTTP, authenticated with ADR-036.
- The provider runs the container(s) and reports status.

Lease states (`liftedinit.billing.v1.LeaseState`):

| State | Meaning |
|-------|---------|
| `LEASE_STATE_PENDING` | Created but not yet active |
| `LEASE_STATE_ACTIVE` | Running and being billed |
| `LEASE_STATE_CLOSED` | Stopped (the user asked to stop) |
| `LEASE_STATE_REJECTED` | Provider declined |
| `LEASE_STATE_EXPIRED` | Credits ran out, provider terminated, or other forced close |

In user-facing copy, Barney maps `closed` → "stopped". The AI is told never to use the word "lease".

### Credits and the billing module

The `billing` module owns credit accounts:

- `MsgFundCredit` — moves PWR from your wallet to your credit account (`fund_credits` in Barney).
- `MsgWithdraw` — pulls value out of the billing module back to a beneficiary address (not currently exposed via the AI).
- `MsgCloseLease` — terminates a lease, returning unused credit (the on-chain side of `stop_app`).
- Continuous draining — every block, the chain debits each active lease's per-second rate from the tenant's credit balance.

`get_balance` returns wallet balances *and* the credit account balance, plus a spending rate computed from the active leases.

### Manifests

A manifest is a small JSON document describing what to run. The single-service form is roughly Docker-compose-flavoured (image, ports, env, tmpfs, command, args, health_check, …); the stack form wraps multiple services under `{ services: { ... } }`. See [docs/user/manifest-format.md](../user/manifest-format.md) for the user-facing reference.

Barney never sends the raw manifest to the chain. Only its **SHA-256 hash** (the `metaHash`) goes on chain as part of `MsgCreateLease`. The full payload is uploaded to the provider over HTTP. This keeps chain state cheap and lets tenants update manifests without a chain transaction (where the protocol allows it).

### The provider runtime (Fred)

Fred exposes a small HTTP + WebSocket API per provider, all authenticated with ADR-036:

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/leases/{uuid}/data` | Upload manifest payload |
| `GET /v1/leases/{uuid}/status` | Container status (running, restarting, failed, …) |
| `GET /v1/leases/{uuid}/provision` | Provisioning state (uploading, provisioning, ready, error details) |
| `GET /v1/leases/{uuid}/info` | Lease info (services, instances) |
| `GET /v1/leases/{uuid}/connection` | Resolved connection info (FQDN, ports per service/instance) |
| `GET /v1/leases/{uuid}/logs?tail=N` | Container logs |
| `POST /v1/leases/{uuid}/restart` | Restart |
| `POST /v1/leases/{uuid}/update` | Update (with new manifest payload) |
| `GET /v1/leases/{uuid}/releases` | Release/version history |
| `WS  /v1/leases/{uuid}/events` | Status streaming |

Barney delegates the HTTP wrappers to `@manifest-network/manifest-mcp-fred`, injecting Barney's CORS proxy / SSRF `fetchFn` adapter. Browser-specific code (the WebSocket connection, polling fallback) stays in `src/api/fred.ts`.

### MCP libraries

The `@manifest-network/manifest-mcp-*` packages are shared libraries used by Barney *and* by the Manifest [MCP server](https://modelcontextprotocol.io) implementation. They consolidate the bits of code that would otherwise drift between the two:

- `manifest-mcp-core` — `CosmosClientManager`, message builders, `cosmosTx` helper for raw transactions, common types.
- `manifest-mcp-fred` — provider HTTP functions, manifest builders (`buildManifest`, `mergeManifest`, `validateServiceName`).
- `manifest-mcp-chain` — faucet client, chain-side helpers (`requestFaucetCredit`).

The Barney repo carries Barney-specific behaviour locally (UI progress callbacks, dev CORS proxy, tool result caching, etc.) and delegates the rest. See `src/api/fred.ts` and `src/ai/manifest.ts` for the canonical wrapping pattern.

### The Morpheus API

Morpheus is an OpenAI-compatible LLM inference service. Barney talks to it via `/api/morpheus/...` — a server-side reverse proxy (nginx in production, the Rsbuild dev proxy in development) that injects `Authorization: Bearer ${MORPHEUS_API_KEY}`. The browser never sees the API key, and the model never speaks directly to the chain — Barney executes every tool call locally and feeds results back as `tool`-role messages.

The default model is `minimax-m2.5`, configurable via `PUBLIC_MORPHEUS_MODEL`.

## Glossary

| Term | Definition |
|------|------------|
| ADR-036 | Cosmos standard for off-chain "sign arbitrary data" signatures |
| Bech32 | The address encoding used by Cosmos chains (`manifest1...`) |
| CometBFT | The Tendermint-derived consensus engine that powers Cosmos chains |
| Coin | `{ amount, denom }` integer balance |
| Credit account | On-chain PWR balance that pays for active leases |
| Denom | Denomination identifier; `umfx`, `factory/.../upwr` |
| Fred | The per-provider runtime that schedules containers |
| Lease | Billing-and-execution agreement between a tenant and a provider |
| LCD / REST | Cosmos REST gateway, default port 1317 |
| `manifestjs` | Generated TypeScript client for Manifest's modules |
| MCP | Model Context Protocol |
| `metaHash` | SHA-256 of the manifest payload, stored on chain |
| Provider | A node operator running Fred, listed on chain |
| RPC | Tendermint RPC, default port 26657 |
| SKU | "Stock-Keeping Unit"; the chain's name for a resource tier |
| `tokenfactory` | Cosmos SDK module that mints child denoms |

## Further reading

- [Cosmos SDK documentation](https://docs.cosmos.network/) — modules, transactions, queries.
- [CometBFT documentation](https://docs.cometbft.com/) — consensus engine.
- [`@cosmjs/stargate` reference](https://cosmos.github.io/cosmjs/) — the signing client Barney uses.
- [cosmos-kit](https://docs.cosmoskit.com/) — wallet abstraction.
