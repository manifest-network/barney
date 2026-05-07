# Troubleshooting

This guide covers the most common problems encountered in Barney and how to resolve them. If your issue isn't listed, file a bug at <https://github.com/manifest-network/barney/issues> with reproduction steps.

## Sign-in problems

### "Pop-up was blocked by your browser"

Web3Auth opens a pop-up window for OAuth. If your browser blocks it, the connect flow fails immediately and a toast surfaces the error.

**Fix:** allow pop-ups for the Barney domain (Safari is the most common offender) and click **Connect** again.

### "Login cancelled"

You closed the Web3Auth pop-up before completing sign-in. Click **Connect** again.

### "Connection failed: …" (other)

A generic cosmos-kit / Web3Auth error. The detail is logged to the browser console under `AppShell.walletConnect`. Common causes:

- The Web3Auth network mismatch — the Barney instance is configured for `sapphire_devnet` but your account exists on `sapphire_mainnet` (or vice versa). Use the matching environment.
- Web3Auth service outage — try again in a few minutes.

### "Wallet does not support signArbitrary"

Some wallets do not support the ADR-036 off-chain signature scheme that Barney uses for provider authentication. The current Web3Auth integration does support it. If you see this error after the install scripts have changed, the wallet client may need an update.

## Account setup overlay

The account-setup overlay only runs when a faucet is configured (`PUBLIC_FAUCET_URL`). On hosted testnet, it auto-provisions you on first connect.

### "Faucet tokens not received within timeout"

The faucet accepted your request but the balance never increased on chain. Possible causes:

- **Cooldown.** Each `(address, denom)` pair has a 24-hour cooldown. If you've received tokens in the last day, the faucet rejects subsequent requests until the cooldown expires.
- **Block delay.** Manifest blocks are ~6 s. The poll waits up to `ACCOUNT_SETUP_POLL_TIMEOUT_MS` (10 s by default). On a busy chain, the deposit may land just after the timeout.
- **Faucet outage.** The configured faucet endpoint is unreachable.

The pipeline retries each step once. If both attempts fail, the overlay surfaces the error and dismisses after a delay. You can call `request_faucet` from chat once the cooldown expires, or contact support.

### "Funding credits failed"

The PWR-to-credits transfer transaction failed. The most common cause is insufficient PWR — the previous step may have hit the cooldown. Check `Get balance` once you can move past the overlay.

### Setup runs every time I connect

The overlay state is keyed off `barney-refill-{address}` in localStorage (the name is a legacy of the prior `useAutoRefill` hook). If you cleared site data or are on a new browser, setup re-runs from scratch.

## Deploy problems

### "Provider unhealthy"

The selected provider is not responding to health checks. Barney's catalog browser surfaces health status; the AI will pick a healthy provider when there is one.

**Fix:** ask `Browse catalog` to see provider health, then retry. If every provider is unhealthy, the chain has no available capacity right now.

### Deploy stuck at "creating_lease"

The lease transaction is broadcast but waiting for inclusion. Most often this resolves within one block (~6 s). If it stays stuck:

- Check your MFX (gas) balance — `Check my balance`. Insufficient gas means the transaction never actually broadcast.
- Check the chain status — if RPC is unreachable, switch to a known-good endpoint.

The deploy auto-fails after `AI_DEPLOY_PROVISION_TIMEOUT_MS` (5 minutes by default). The error appears in the chat with the stuck phase.

### Deploy stuck at "uploading"

The lease was created on chain, but the manifest upload to the provider is failing.

- Check that your manifest is ≤ 5 KB.
- Check the provider's URL is reachable (catalog → click provider).
- Check the browser console for SSRF rejections — Barney refuses to talk to private/internal addresses unless running locally.

### Deploy stuck at "provisioning"

The provider received the manifest but can't start the container. Run `app_diagnostics <name>` to fetch the provider's last error. Common causes:

- **Image pull failure** — typo in image name, private registry without credentials, network outage at the provider.
- **Resource exhaustion** — the provider doesn't have enough capacity for the requested tier.
- **Manifest validation rejection** — the provider's runtime validator caught something the client missed (rare).

### "Insufficient credits"

You don't have enough PWR in your credit account to cover the chosen tier. Either:

- Top up: `Add 50 credits`.
- Pick a smaller tier: `Deploy redis as micro`.

### Generated manifest exceeds 5 KB

You attached an oversized manifest (raw input) or asked for a stack with too many services. Remove non-essential fields, split into smaller deploys, or shorten env values.

## Runtime problems

### "App is failed"

After provisioning succeeds, the container can still crash. `app_status <name>` and `get_logs <name>` surface what the container is saying. `app_diagnostics <name>` surfaces what the *provider* thinks happened.

### "Provisioning succeeded but the URL doesn't load"

A few possibilities:

- The container is up but slow to start. Wait a few seconds, then retry. Configure a `health_check` with a `start_period` to give the container time to warm up before the provider considers it unhealthy.
- The container does not bind to the port declared in the manifest. Re-check the image's documentation.
- The container binds only to `127.0.0.1`. Configure it to listen on `0.0.0.0` so the provider's network stack can reach it.

### Logs appear truncated

`get_logs` defaults to the last 100 lines. Ask for more: `Tail 1000 lines of redis logs`. The provider may impose its own ceiling.

### App stopped unexpectedly

Run `lease_history` to see whether the lease state changed (most likely `closed` due to insufficient credits, or `expired` after a provider outage). `app_diagnostics` will surface a last-error if any.

## Chat and AI problems

### "Stream timed out"

The Morpheus API stream stalled for longer than `AI_STREAM_TIMEOUT_MS` (default 30 s). The chat surface does not auto-retry — resend the message. (The `AI_MAX_RETRIES` / `withRetry` pair applies to blockchain API calls during tool execution, not to the Morpheus chat stream itself.)

If timeouts persist:

- Check the Morpheus API status.
- For self-hosted instances, increase `PUBLIC_AI_STREAM_TIMEOUT_MS` (max 120 s) on the container.

### "Connection lost" / "Disconnected"

Barney runs a periodic health check against the Morpheus proxy (`AI_HEALTH_CHECK_INTERVAL_MS`, 60 s). When checks fail, the badge in the chat header turns red and the interval backs off (capped at `AI_HEALTH_CHECK_MAX_BACKOFF` × the base interval).

If you see persistent disconnection on a self-hosted instance, the most common causes are:

- `MORPHEUS_API_KEY` was rotated and the container wasn't restarted.
- nginx cached a stale upstream IP. The `nginx.conf.template` uses `resolver … valid=30s` to refresh DNS every 30 s. Older configs without the resolver directive cache the IP forever — restart the container until the rendered config has the directive.

### "Tool call iteration limit reached"

The AI made too many tool calls in a single turn (default 10, max 50 via `PUBLIC_AI_MAX_TOOL_ITERATIONS`). Usually means the model is looping. Send a more specific prompt, or check the conversation for a contradiction the model is trying to resolve.

### Confirmation card timed out

Pending confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes). If you stepped away, the request was discarded. Re-issue the prompt.

### Pasted text is cut off

The chat input enforces a hard 64 KB ceiling per message (`MAX_INPUT_LENGTH` in `src/ai/validation.ts`). A warning appears at 80 % of the cap; anything over the cap is rejected on submit. If you need to send a large file, attach it as a manifest upload instead.

### Chat history disappears

Chat history is stored in `barney-ai-history` in localStorage as plain JSON validated on load by `validateChatHistory`. It is wiped if:

- A persisted entry fails JSON parsing or schema validation — the key is removed and the app starts with an empty history. (There is no version envelope or migration chain; corrupted entries are simply dropped.)
- You switched browsers or cleared site data.
- You ran `/clear`.

The on-chain state and your apps are unaffected.

## Browser-side problems

### "Failed to fetch" (development only)

The Rsbuild dev proxy validates every provider URL with `isValidProxyTarget` before routing the request. The validator blocks:

- Non-HTTP protocols.
- URLs with embedded credentials.
- Cloud metadata hostnames (`metadata.*`, `instance-data.*`).
- DNS-rebinding services (`*.nip.io`, `*.xip.io`, `*.sslip.io`).
- Multicast, link-local, reserved, and benchmarking IP ranges.

If your provider URL is legitimately blocked, the validator likely caught a real misconfiguration. Otherwise, set up your provider with a real DNS name.

### CSP violations in the console

The `Content-Security-Policy` in `index.html` is restrictive. `unsafe-inline` and `unsafe-eval` are scoped to the script and style sources required by Web3Auth and cosmos-kit. If you forked Barney and added a new third-party script, you'll need to widen the policy in `index.html` to whitelist the source.

## Where to look next

- [AI cookbook](ai-cookbook.md) — confirm you're invoking the right tool.
- [Manifest format](manifest-format.md) — verify your manifest is well-formed.
- The browser DevTools console — every catch block calls `logError(context, error)` with a descriptive context string. The full error is logged there, even when the chat surfaces a sanitized message.
- For developers, [docs/dev/security.md](../dev/security.md) explains the validation layers in detail.
