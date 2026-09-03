# Getting started

This guide walks you through signing into Barney, completing first-time account setup, and deploying your first application.

## Choose an instance

Barney is a self-contained single-page application. You can use a hosted instance or run your own.

| Environment | URL | When to use |
|-------------|-----|-------------|
| Mainnet | <https://barney.manifest.network> | Production deployments on Manifest Mainnet |
| Testnet | <https://barney.testnet.manifest.network> | Development, experimentation, free credits via faucet |
| Local | <http://localhost:3000> | Self-hosted or development build |

For self-hosting, see the [deployment guide](../dev/deployment.md).

## Signing in

Barney uses [Web3Auth](https://web3auth.io) social login through cosmos-kit. There is no traditional username and password — your wallet is derived from your social identity.

1. Click **Connect** on the landing page.
2. Choose **Google** (the only login provider currently enabled).
3. Approve the cosmos-kit pop-up. Web3Auth derives a Manifest-bech32 address (`manifest1…`) from your account.
4. The address is displayed in the sidebar once connected.

> **Pop-ups must be allowed for the Barney domain.** Safari blocks them by default. If the connect flow returns "popup blocked", enable pop-ups for the site and retry.

Sessions last 24 hours. Disconnecting clears the session locally; your on-chain state and apps are unaffected.

### What lives in your browser

Barney stores a small set of values in `localStorage`. Some are global to the browser profile, some are scoped to the connected wallet, and chat history is scoped to the wallet *and* the network:

**Global (shared across wallets):**

- Tunable AI settings (`barney-ai-settings`)
- Theme selection (`barney-theme`)

**Per wallet and network (keyed by chain ID plus normalized address):**

- Chat history (`barney-ai-history:v1:{chainId}:{normalizedAddress}`)

**Per-wallet (keyed by connected address):**

- Your registered apps and their manifests, with secret-shaped env values scrubbed (`barney-apps-{address}`)
- One-shot account-setup flag (`barney-refill-{address}`)

Each wallet/network transcript is retained in this browser profile until you
connect that identity and run `/clear` (or use **Clear This Wallet's History**
in AI Settings), or clear the site's browser data. Turning **Save Chat History**
off stops future writes but does not delete any previously saved wallet
transcript; new messages remain available only in the current tab. Disconnecting
hides the active transcript without assigning it to a later wallet; reconnecting
the same wallet and network selects its own isolated transcript.

Nothing else leaves the browser unencrypted. The only outbound calls are to the configured Manifest RPC/REST node, the providers your apps run on, and Barney's authenticated Morpheus relay. On the first chat (and after session expiry/restart), your wallet signs a short-lived chain/address-bound challenge. The resulting session is an HttpOnly cookie; the browser never sees the operator API key.

## First-time account setup

On first connect, Barney can auto-provision your account so you can deploy immediately. This step is enabled when the deployment is configured with a faucet (`PUBLIC_FAUCET_URL`). The hosted **testnet** has a faucet; the hosted **mainnet** does not.

The `AccountSetupOverlay` runs a sequential pipeline:

1. **Check PWR (gas + credit token).** If your wallet PWR balance is below 5 PWR, request `upwr` from the faucet and wait for confirmation on-chain. PWR pays both transaction fees *and* funds your credit account.
2. **Check credits.** If your credit account balance is below 5 PWR, fund the credits account with 10 PWR.

Each step retries once on failure. If a step still fails after retry, the overlay surfaces the error and the pipeline stops. You can refill manually later (see [funding credits](#funding-credits)).

The faucet enforces a 24-hour cooldown per `(address, denom)` pair. If you've already used the faucet today, that step is skipped. MFX is no longer required to operate Barney; if you need MFX for staking or governance, request it via the `Request faucet tokens` chat command.

If `PUBLIC_FAUCET_URL` is unset (e.g. mainnet, or a custom self-hosted instance), this overlay does not run. You will need to fund your account out of band before deploying.

## Vocabulary

The chat UI uses end-user vocabulary, not chain vocabulary. The mapping is:

| You see | The chain calls it |
|---------|--------------------|
| App | Lease |
| Stopped | Closed |
| Credits | PWR (`upwr` factory denom) |
| Gas | PWR (`upwr` factory denom) — same token as credits after ENG-243 |
| Tier or size | SKU |
| Provider | Provider (a node operator running Fred) |

## Your first deploy

Type one of the following into the chat:

```
Deploy tetris
```

The model recognises Tetris from the curated demo-games catalog and calls `deploy_app` with the matching image and port. A confirmation card appears showing the manifest. You can:

- **Accept** — broadcasts the lease transaction and uploads the manifest payload.
- **Edit** — modify the manifest in place, then accept.
- **Cancel** — discard the request.

After acceptance, the progress card shows:

```
creating_lease  →  uploading  →  provisioning  →  ready
```

When provisioning completes, a clickable URL appears in the chat. The same app shows up in the sidebar, where you can re-open it, view logs, restart, stop, or update.

### Deploying from a Docker image

```
Deploy redis
Deploy postgres 17
Deploy nginx with port 80
```

Barney recognises a curated set of well-known images and applies sensible defaults (port, env, user, tmpfs, health check). For unknown images, the assistant will ask for the missing details (port, env vars).

### Deploying from a manifest file

Attach a JSON or YAML file to your message:

```
Deploy this  (File attached: my-manifest.json)
```

The app name is derived from the filename (extension stripped, lower-cased, invalid characters replaced with hyphens). Override it explicitly:

```
Deploy as my-app  (File attached: manifest.json)
Deploy as medium  (File attached: manifest.json)
```

See [manifest format](manifest-format.md) for the full schema.

### Deploying a stack

Multi-service stacks (e.g. WordPress + MySQL) are first-class:

```
Deploy WordPress with MySQL
Deploy Ghost blog
```

Barney builds a stack manifest using the curated `KNOWN_STACKS` catalog. All services in a stack share the same tier, communicate via DNS using their service name (e.g. `db:3306`), and each counts toward credits separately.

## Managing apps

The AI handles the most common operations through chat:

| Intent | Example prompt |
|--------|---------------|
| List running apps | `What's running?` |
| Status of one app | `Check my-api` |
| View logs | `Show logs for redis` |
| Stop one app | `Stop tetris` |
| Stop several | `Stop redis and postgres` |
| Stop everything | `Stop all apps` |
| Restart | `Restart my-app` |
| Update with new image | `Update redis to redis:8` |
| Update with new manifest | `Update my-app  (File attached: manifest.json)` |
| Diagnose a failure | `Why did my-api fail?` |
| View release history | `Show releases for my-app` |

All app names support a comma-separated form (`stop_app(app_name="redis,postgres")`) and the literal `all` (`stop_app(app_name="all")`). The AI handles the conversion when you ask in natural language.

## Funding credits

```
Check my credits
Add 50 credits
Request faucet tokens
```

Credits are denominated in PWR (display units; 1 PWR = 1,000,000 `upwr`). Funding moves PWR from your wallet to your credit account on chain, where it pays for active leases.

The faucet enforces a 24-hour cooldown per token. Use `Request faucet tokens` (testnet only) when you need free PWR (covers both gas and credits) and MFX for testing.

## Catalog and providers

```
Browse catalog
Show available tiers
```

The catalog lists active providers and their available SKU tiers (typically `docker-micro`, `docker-small`, `docker-medium`, `docker-large`). Pricing is shown per hour or per day depending on the SKU's billing unit.

| Tier | CPU | Memory | Disk |
|------|-----|--------|------|
| `docker-micro` | 0.5 cores | 512 MB | 1 GB |
| `docker-small` | 1 core | 1,024 MB | 5 GB |
| `docker-medium` | 2 cores | 2,048 MB | 10 GB |
| `docker-large` | 4 cores | 4,096 MB | 20 GB |

Larger tiers such as `docker-small` provide more disk. There is no `storage` deploy flag; select a larger tier by naming the size explicitly (e.g. "Deploy as small").

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus chat input |
| `Enter` | Send message |
| `Shift + Enter` | New line in chat input |
| `↑` / `↓` | Browse input history (chat input only) |
| `Esc` | Stop a streaming reply if one is in flight; otherwise close the open modal or sidebar |
| `?` | Show keyboard shortcuts modal |

## Mobile

On narrow viewports the sidebar slides over the chat. Open it with the toggle in the top-left and dismiss it by swiping left more than ~80 px, tapping the backdrop, or pressing `Esc`.

## Themes

Seven themes ship out of the box: `dark` (default), `light`, `retro`, `nord`, `dracula`, `catppuccin`, `matrix`. The theme picker lives in the AI settings panel. The `matrix` theme adds an animated background.

Themes respect `prefers-reduced-motion`; the matrix animation pauses if you have that preference set.

## Next steps

- [AI cookbook](ai-cookbook.md) — example prompts grouped by task
- [Manifest format](manifest-format.md) — write your own manifests
- [Troubleshooting](troubleshooting.md) — when something goes wrong
