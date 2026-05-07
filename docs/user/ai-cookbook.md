# AI cookbook

This cookbook documents the 16 tools the AI can call, what each does, and how to invoke them in natural language. The model performs intent classification; you do not need to know tool names. Behind every chat reply is one or more deterministic tool calls executed in your browser — the model never speaks directly to the chain.

A confirmation step is required for transactions that move tokens or change on-chain state. Queries return immediately.

## Reading this guide

For each tool you'll see:

- **What it does** — concise statement of behaviour.
- **Example prompts** — natural-language phrasings that trigger the tool.
- **What runs under the hood** — the tool name and the most relevant parameters, so you can understand the confirmation card or correlate logs.

## Deploy and lifecycle (transactions)

### `deploy_app`

**What it does.** Creates a lease on Manifest Network, uploads a manifest payload to the selected provider, and waits for provisioning.

**Example prompts.**

```
Deploy tetris
Deploy redis
Deploy postgres 17
Deploy nginx with port 80
Deploy as medium  (File attached: my-manifest.json)
Deploy this  (File attached: app.yaml)
Deploy WordPress with MySQL
Deploy tetris, doom, and pacman
```

**Under the hood.** `deploy_app(app_name?, size?, image?, port?, env?, user?, tmpfs?, command?, args?, storage?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)`.

- `image` and `services` are mutually exclusive. `services` is a JSON object describing a multi-service stack.
- `size` defaults to `micro`. Set to `small` when you need persistent disk storage; `storage: true` auto-selects `docker-small` regardless of the requested size.
- For curated images (Postgres, Redis, MySQL, …), default ports, env, user, and tmpfs are pre-populated.
- Empty values in the `env` map auto-generate alphanumeric passwords (e.g. `{"POSTGRES_PASSWORD":""}`).
- The deploy progresses through `creating_lease → uploading → provisioning → ready`, surfaced live in the progress card.

### `update_app`

**What it does.** Updates a running app with a new manifest, image, or service stack. The lease keeps its UUID; the manifest is replaced.

**Example prompts.**

```
Update redis to redis:8
Update my-app  (File attached: manifest.json)
Update wordpress to use a new theme  (File attached: stack.json)
```

**Under the hood.** `update_app(app_name, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)`. Like `deploy_app`, `image` and `services` are mutually exclusive.

### `restart_app`

**What it does.** Restarts the container(s) without changing the manifest.

**Example prompts.**

```
Restart redis
Restart redis, postgres
Restart all apps
Restart all tetris apps          (the AI lists matching apps first)
```

**Under the hood.** `restart_app(app_name)`. `app_name` accepts a single name, a comma-separated list, or the literal string `all`.

### `stop_app`

**What it does.** Closes the lease, terminating the running container(s) and freeing credits.

**Example prompts.**

```
Stop my-api
Stop redis and postgres
Stop all apps
```

**Under the hood.** `stop_app(app_name)`. Accepts the same shapes as `restart_app`.

### `fund_credits`

**What it does.** Moves PWR from your wallet to your on-chain credit account. Credits pay for active leases.

**Example prompts.**

```
Add 50 credits
Top up my credits with 100 PWR
```

**Under the hood.** `fund_credits(amount)`. The amount is in display units (1 PWR = 1,000,000 `upwr`).

## Query tools (no confirmation)

### `list_apps`

**What it does.** Lists your apps, optionally filtered by state.

**Example prompts.**

```
What's running?
List my apps
Show stopped apps
What's deploying?
```

**Under the hood.** `list_apps(state?)`. Defaults to `running`. Other values: `all`, `stopped`, `failed`, `deploying`.

### `app_status`

**What it does.** Returns a unified status view combining the registry, the chain, and the provider (Fred).

**Example prompts.**

```
Check my-api
Status of redis
Is wordpress healthy?
```

**Under the hood.** `app_status(app_name)`.

### `get_logs`

**What it does.** Fetches container logs from the provider running the app.

**Example prompts.**

```
Show logs for my-app
Tail 500 lines of redis logs
```

**Under the hood.** `get_logs(app_name, tail?)`. `tail` defaults to 100.

### `get_balance`

**What it does.** Returns wallet balances (MFX, PWR), credit balance, spending rate, and time-remaining estimate.

**Example prompts.**

```
Check my balance
How long until my credits run out?
Am I out of credits?
```

**Under the hood.** `get_balance()`. The AI will not pre-fetch this — only call it when you ask explicitly.

### `browse_catalog`

**What it does.** Lists active providers with their available SKU tiers and health checks.

**Example prompts.**

```
Browse catalog
What tiers are available?
Show me the providers
```

**Under the hood.** `browse_catalog()`.

### `lease_history`

**What it does.** Returns a paginated list of past leases, optionally filtered by state.

**Example prompts.**

```
Show me my lease history
What apps did I run last week?
Show closed apps
```

**Under the hood.** `lease_history(state?, limit?, offset?)`. `state` is one of `all` (default), `pending`, `active`, `closed`, `rejected`, `expired`. `limit` defaults to 10.

### `app_diagnostics`

**What it does.** Surfaces provisioning diagnostics for a failed app: status, fail count, last provisioning error.

**Example prompts.**

```
Why did my-api fail?
Diagnose redis
What went wrong with wordpress?
```

**Under the hood.** `app_diagnostics(app_name)`.

### `app_releases`

**What it does.** Returns the version/release history of an app — useful after `update_app`.

**Example prompts.**

```
Show releases for my-app
What versions has wordpress run?
```

**Under the hood.** `app_releases(app_name)`.

### `request_faucet`

**What it does.** Requests free MFX and PWR tokens from the configured faucet. Subject to a 24-hour cooldown per `(address, denom)` pair.

**Example prompts.**

```
Get me free tokens
Request faucet
I need testnet credits
```

**Under the hood.** `request_faucet()`. Available only when the deployment is configured with a faucet (`PUBLIC_FAUCET_URL`).

## Escape hatches (advanced)

These tools expose the raw chain. Use them when you need an operation that isn't covered by the higher-level tools.

### `cosmos_query`

**What it does.** Runs a raw Cosmos SDK query against a module.

**Example prompts.**

```
Query bank balances for manifest1...
Run cosmos_query bank balance with [...]
Show staking validators
```

**Under the hood.** `cosmos_query(module, subcommand, args?)`. `module` is one of `bank`, `staking`, `gov`, `auth`, `billing`, `sku`, `provider`. `args` is a JSON-encoded array of strings.

### `cosmos_tx`

**What it does.** Builds, signs, and broadcasts a raw Cosmos SDK transaction. Requires confirmation.

**Example prompts.**

```
Send 10 MFX to manifest1abc...
Run cosmos_tx bank send with [...]
```

**Under the hood.** `cosmos_tx(module, subcommand, args)`.

> Most users will never need the escape hatches. Reach for them only when the higher-level tools cannot express what you want.

## Tips for productive prompting

- **Be specific about size or version when you care.** "Deploy postgres 17" preserves the tag; "Deploy postgres" defaults to whatever the curated catalog suggests.
- **Multiple names = multiple deploys.** "Deploy tetris, doom, and hextris" calls `deploy_app` once per game.
- **Local fast-path for example apps.** When your prompt matches `^deploy <name1>(, |, and | & | and )<name2>...` AND every name maps to a built-in example app, Barney skips the LLM round-trip and runs a batch deploy directly. If even one name doesn't match a built-in example, the entire prompt is sent to the model instead — which may produce different results than you expect. To force the AI path, phrase the request differently ("Please deploy redis and postgres for me").
- **For bulk stop/restart**, use comma-separated lists or `all`. The AI will fall back to `list_apps` first if you ask by pattern (e.g. "stop all tetris apps").
- **The `/help` slash command** prints the in-app cheat sheet.
- **The `/clear` slash command** wipes chat history (the on-chain state is unaffected).
- **If a tool fails transiently**, the AI retries once. If it still fails, you get a plain-language error and a suggested next step.

## What the AI will not do

- Explain blockchain or Cosmos internals unprompted.
- Show transaction hashes unless you ask.
- Pre-fetch your balance or browse the catalog without being asked.
- Help with anything outside app deployment and management.
- List all example apps — the UI renders deploy buttons automatically. The AI will mention a couple by name when you ask for a recommendation.
