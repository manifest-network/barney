# Deployment

Barney ships as one Docker image containing the SPA, nginx, and the
wallet-authenticated Morpheus relay. The canonical image is published on every
release tag to `ghcr.io/manifest-network/barney`. Published architecture follows
the CI runner (currently `linux/amd64`); ARM64 hosts must build the image.

For build details, see [Architecture → Build and deployment](../../ARCHITECTURE.md#build-and-deployment).
For the relay threat model, see [Security model](security.md#1-paid-relay-trust-boundary).

## Image tags

| Tag | Meaning |
|-----|---------|
| `:latest` | Latest stable release |
| `:1` | Latest 1.x release |
| `:1.2` | Latest 1.2.x release |
| `:1.2.3` | Exact release |

Pin an exact tag in production. Pre-release tags do not update `:latest`.

## Required configuration

The relay deliberately has no unlimited financial defaults. Paid inference and
readiness fail closed if any required policy value is absent or malformed; the
supervisor still serves the SPA so non-AI functionality remains available.

| Variable | Purpose |
|----------|---------|
| `PUBLIC_REST_URL`, `PUBLIC_RPC_URL` | Manifest chain endpoints |
| `PUBLIC_CHAIN_ID` | Exact chain bound into every relay challenge/session |
| `PUBLIC_MORPHEUS_URL` | Absolute upstream HTTP(S) base URL; credentials, query, and fragment are rejected |
| `PUBLIC_MORPHEUS_MODEL` | Browser-selected model; must also be server-allowlisted |
| `MORPHEUS_API_KEY` | Provider key read only by the Node relay |
| `MORPHEUS_RELAY_ALLOWED_ORIGINS` | Comma-separated exact browser origins |
| `MORPHEUS_RELAY_STATE_FILE` | Atomic JSON quota-ledger path on persistent storage |
| `MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS` | Per-wallet requests per UTC day |
| `MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS` | Per-wallet accounted tokens per UTC day |
| `MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD` | Per-wallet spend cap in integer micro-USD |
| `MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD` | Provider-wide hard UTC-day cap in integer micro-USD |
| `MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS` | Conservative selected-model input rate |
| `MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS` | Conservative selected-model output rate |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | Web3Auth client ID |

`.env.example` contains a complete local policy. Production operators must
review current model pricing instead of copying the example estimates blindly.
The optional `MORPHEUS_RELAY_IDENTITY_HMAC_KEY` keeps identity pseudonyms stable
when the provider key rotates; otherwise the relay safely derives them from the
provider key while the provider-wide ledger remains intact.

Request controls have bounded defaults and optional overrides:

- exact model allowlist;
- body, prompt, exact forwarded-context byte, output, message-count, and response limits;
- per-identity and provider concurrency;
- upstream-connect and total-stream deadlines;
- challenge/session lifetimes and in-memory capacity;
- maximum pseudonymous identities retained in each daily ledger window.

Identity token and spend quotas use a configurable byte-per-token estimate. The
provider-wide financial reservation separately charges a byte-level upper bound
before provider access, then both settle down to authenticated provider usage.
This avoids treating every byte as a normal identity token while preserving the
hard provider budget.

See `server/config.mjs` for names and hard validation maxima.

## Local development

```bash
cp .env.example .env.local
# Set MORPHEUS_API_KEY and review the example financial policy.
npm run dev
```

`npm run dev` starts the same relay used in production, then Rsbuild. Rsbuild
proxies `/api/morpheus` to localhost and never reads or injects the key. Local
HTTP requires `MORPHEUS_RELAY_COOKIE_SECURE=false`; production should keep the
default `true`.

## Local Docker smoke test

```bash
docker volume create barney-relay-state
docker run --rm -p 8080:80 --env-file .env.local \
  -e MORPHEUS_RELAY_ALLOWED_ORIGINS=http://localhost:8080 \
  -e MORPHEUS_RELAY_AUDIENCE=http://localhost:8080/api/morpheus \
  -e MORPHEUS_RELAY_COOKIE_SECURE=false \
  -e MORPHEUS_RELAY_STATE_FILE=/var/lib/barney-relay/ledger.json \
  -v barney-relay-state:/var/lib/barney-relay \
  ghcr.io/manifest-network/barney:latest
```

Visit <http://localhost:8080>. An anonymous paid POST must return 401; the first
authenticated chat asks the wallet to sign a short-lived challenge.

## Production compose shape

The image exposes only port 80. Put a TLS-terminating reverse proxy in front of
it and persist `/var/lib/barney-relay`. Do not publish relay port 8081. The relay
binds loopback by default for nginx; set `MORPHEUS_RELAY_HOST=0.0.0.0` only when
a private container-network Prometheus scrape requires the direct metrics port.

```yaml
services:
  barney:
    image: ghcr.io/manifest-network/barney:1.2.3
    restart: always
    ports:
      - "8080:80"
    volumes:
      - barney-relay-state:/var/lib/barney-relay
    environment:
      PUBLIC_REST_URL: https://nodes.manifest.network/manifest/api
      PUBLIC_RPC_URL: https://nodes.manifest.network/manifest/rpc
      PUBLIC_CHAIN_ID: manifest-ledger-mainnet
      PUBLIC_MORPHEUS_URL: https://api.mor.org/api/v1
      PUBLIC_MORPHEUS_MODEL: your-reviewed-model
      MORPHEUS_API_KEY: ${MORPHEUS_API_KEY}
      MORPHEUS_RELAY_ALLOWED_MODELS: your-reviewed-model
      MORPHEUS_RELAY_ALLOWED_ORIGINS: https://barney.example.com
      MORPHEUS_RELAY_AUDIENCE: https://barney.example.com/api/morpheus
      MORPHEUS_RELAY_STATE_FILE: /var/lib/barney-relay/ledger.json
      MORPHEUS_RELAY_IDENTITY_DAILY_REQUESTS: "100"
      MORPHEUS_RELAY_IDENTITY_DAILY_TOKENS: "1000000"
      MORPHEUS_RELAY_IDENTITY_DAILY_SPEND_MICRO_USD: "2000000"
      MORPHEUS_RELAY_PROVIDER_DAILY_BUDGET_MICRO_USD: "25000000"
      MORPHEUS_RELAY_INPUT_MICRO_USD_PER_MILLION_TOKENS: "REVIEW_CURRENT_RATE"
      MORPHEUS_RELAY_OUTPUT_MICRO_USD_PER_MILLION_TOKENS: "REVIEW_CURRENT_RATE"
      PUBLIC_WEB3AUTH_CLIENT_ID: ${WEB3AUTH_CLIENT_ID}
      PUBLIC_WEB3AUTH_NETWORK: sapphire_mainnet
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/api/morpheus/readyz"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  barney-relay-state:
```

Replace both `REVIEW_CURRENT_RATE` placeholders with positive integer micro-USD
rates before deployment; leaving either string causes startup to fail.

If a trusted reverse proxy supplies `X-Forwarded-For`, set
`BARNEY_TRUSTED_PROXY_CIDR` to that proxy's exact IPv4 `/32`. The entrypoint
rejects broad, malformed, or injectable values. This affects only nginx's coarse
IP controls; wallet identity always owns financial accounting.

## Startup sequence and secret boundary

`/docker/env.sh`:

1. validates the trusted-proxy IPv4 `/32` and relay port;
2. renders nginx config from only that trusted-proxy address and local relay port;
3. renders browser `config.js` from public variables only;
4. validates the secret-free nginx configuration;
5. executes the requested command, defaulting to the Node supervisor.

The supervisor starts nginx so the SPA can degrade gracefully, then validates
the complete relay policy and loads/creates the durable ledger. It removes the
provider and identity-HMAC keys from nginx's child environment. The development
supervisor removes the same secrets from Rsbuild. The key reaches only the
relay's outbound `Authorization` header.

Static hosting alone is no longer a valid deployment shape. A worker/function
replacement must implement the same wallet proof, session binding, durable
reservation, quotas, hard budget, and request limits—not merely inject a key.

## Health and monitoring

| Endpoint | Exposure | Meaning |
|----------|----------|---------|
| `/api/morpheus/healthz` | public through nginx | relay-process liveness only |
| `/api/morpheus/readyz` | public/internal through nginx | ledger, default-request budget, and cached authenticated-provider readiness |
| `/metrics` on relay port 8081 | loopback by default; private network only when explicitly bound | aggregate request, rejection, usage, spend, budget, concurrency, and max identity-quota utilization |

Metrics never contain wallet addresses, identity hashes, prompts, cookies, or
keys. Logs likewise use only request IDs, bounded event names, and numeric
upstream statuses.

## Updating

Preserve the relay-state volume across image replacement:

```bash
docker pull ghcr.io/manifest-network/barney:1.2.4
yq -i '.services.barney.image = "ghcr.io/manifest-network/barney:1.2.4"' compose.yaml
docker compose up -d barney
```

SPA history remains in browser localStorage. Relay sessions are intentionally
in-memory and do not survive a restart; the next chat asks for a new wallet
signature. The durable daily ledger does survive and must never be reset as an
upgrade shortcut.

## Safe rollback

Do not roll back to a release that exposes an anonymous key-injecting proxy
while the paid key and public route remain active. First remove/block the public
`/api/morpheus` route (or stop Barney entirely), then roll back to another
authenticated/accounted release with the same state volume mounted. Preserve the
ledger throughout. Deleting it can permit spend beyond the day's hard budget.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| SPA loads but AI is unavailable | Missing/invalid relay policy, unreadable/corrupt ledger, provider readiness failure, or exhausted budget |
| 401 | Missing/expired/restarted/logged-out wallet session; re-authentication is expected |
| 403 | Wallet/chain/session binding, origin, or model mismatch |
| 429 | Identity quota or concurrency ceiling |
| 503 from paid POST | Provider hard budget/concurrency ceiling or relay unavailable |
| 502/504 | Sanitized upstream failure, response limit, connection deadline, or total-stream deadline |
| Liveness succeeds but readiness fails | Provider/key, durable accounting, or default-request budget is unavailable |
| Provider URL blocked in dev | Rsbuild's separate provider URL safety guard rejected it; see [security.md](security.md) |

Never paste `docker inspect`, provider headers, or environment output into logs,
tickets, or chat: root-visible container metadata contains the provider key.
