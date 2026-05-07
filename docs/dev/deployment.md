# Deployment

This guide describes how to deploy Barney in production. The canonical artifact is the Docker image published on every release tag to `ghcr.io/manifest-network/barney`. The build does not pin a target platform, so the published image's architecture matches the CI runner — currently `linux/amd64` on `ubuntu-latest`. ARM64 hosts (Apple Silicon, Graviton) need to build the image themselves.

For build-system details (the multi-stage Dockerfile, the Brotli compile step, version stamping) see [ARCHITECTURE.md → Build and deployment](../../ARCHITECTURE.md#build-and-deployment).

## Image tags

| Tag | What it points to |
|-----|-------------------|
| `:latest` | Latest stable (non-prerelease) version |
| `:1` | Latest in the 1.x line |
| `:1.2` | Latest in the 1.2.x line |
| `:1.2.3` | Exact pinned version |

Pre-release tags (`v1.0.0-rc.1` and similar) are pushed as pre-releases and do *not* update `:latest`.

For production, pin to a specific version (`:1.2.3`) and update deliberately. Use `:1` or `:1.2` only in non-production environments where automatic minor bumps are acceptable.

## Required and recommended configuration

The container expects a small number of environment variables. The full reference lives in [the README env-var table](../../README.md#environment-variables); this section calls out what's actually required.

### Required

| Variable | Purpose |
|----------|---------|
| `PUBLIC_REST_URL` | Manifest LCD/REST endpoint |
| `PUBLIC_RPC_URL` | Manifest RPC endpoint |
| `PUBLIC_CHAIN_ID` | Chain ID for cosmos-kit and signing (`manifest-ledger-mainnet` for production, `manifest-ledger-testnet` for testnet, `manifest-ledger-beta` for the staging chain) |
| `PUBLIC_MORPHEUS_URL` | Morpheus API endpoint — `env.sh` fails fast if empty or contains `?`/`#` |
| `MORPHEUS_API_KEY` | Server-side only. Injected by nginx as `Authorization: Bearer …`. Never reaches the browser. |
| `PUBLIC_WEB3AUTH_CLIENT_ID` | Web3Auth client ID. The default `YOUR_WEB3AUTH_CLIENT_ID` placeholder will fail social login. |

### Strongly recommended

| Variable | Purpose |
|----------|---------|
| `PUBLIC_GAS_PRICE` | Match the chain's recommended fee. Default `0.0025umfx` is fine for most operators. |
| `PUBLIC_PWR_DENOM` | The factory denom for PWR on this chain. Use the chain's canonical value. |
| `PUBLIC_FAUCET_URL` | Enables first-connect account auto-provisioning. Leave empty on mainnet. |
| `PUBLIC_WEB3AUTH_NETWORK` | `sapphire_mainnet` for production, `sapphire_devnet` for testnet. |

### Tunables

The `PUBLIC_AI_*` knobs adjust timeouts and concurrency. The defaults are safe; only change them if you have a specific reason. Each is clamped to a hard ceiling — see `src/config/runtimeConfig.ts` (`NUMERIC_LIMITS`).

## Running locally

```bash
docker run --rm -p 8080:80 \
  -e PUBLIC_REST_URL=https://nodes.liftedinit.tech/manifest/testnet/api \
  -e PUBLIC_RPC_URL=https://nodes.liftedinit.tech/manifest/testnet/rpc \
  -e PUBLIC_CHAIN_ID=manifest-ledger-testnet \
  -e PUBLIC_WEB3AUTH_CLIENT_ID=your_client_id \
  -e PUBLIC_WEB3AUTH_NETWORK=sapphire_devnet \
  -e PUBLIC_MORPHEUS_URL=https://api.mor.org/api/v1 \
  -e MORPHEUS_API_KEY=your_api_key \
  ghcr.io/manifest-network/barney:latest
```

Visit <http://localhost:8080>. Sign in with Google, complete account setup, deploy something.

## Running in production

The container exposes port 80 (HTTP). Put a TLS-terminating load balancer or reverse proxy in front of it. The nginx config inside the container enables HTTP/2 cleartext (`http2 on`) so the upstream connection from a TLS-terminating proxy can use h2c if the proxy supports it.

A minimal compose file:

```yaml
services:
  barney:
    image: ghcr.io/manifest-network/barney:1.2.3
    restart: always
    ports:
      - "8080:80"
    environment:
      PUBLIC_REST_URL: https://nodes.manifest.network/manifest/api
      PUBLIC_RPC_URL: https://nodes.manifest.network/manifest/rpc
      PUBLIC_CHAIN_ID: manifest-ledger-mainnet
      PUBLIC_PWR_DENOM: factory/manifest1.../upwr
      PUBLIC_WEB3AUTH_CLIENT_ID: ${WEB3AUTH_CLIENT_ID}
      PUBLIC_WEB3AUTH_NETWORK: sapphire_mainnet
      PUBLIC_MORPHEUS_URL: https://api.mor.org/api/v1
      MORPHEUS_API_KEY: ${MORPHEUS_API_KEY}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/index.html"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Pin the image tag. Do not use `:latest` in production.

## How startup works

The image entrypoint is `/docker/env.sh`. On every container start, it:

1. **Validates `PUBLIC_MORPHEUS_URL`.** Empty or containing `?`/`#` is a hard failure.
2. **Strips trailing slashes** from `PUBLIC_MORPHEUS_URL` to avoid double-slash in the upstream `proxy_pass`.
3. **Extracts IPv4 DNS resolvers** from `/etc/resolv.conf` (with `1.1.1.1 8.8.8.8` as a fallback) for nginx's `resolver` directive.
4. **Renders `/etc/nginx/conf.d/default.conf`** from `nginx.conf.template` with `MORPHEUS_API_KEY`, `PUBLIC_MORPHEUS_URL`, and `NGINX_RESOLVERS` substituted via `envsubst`.
5. **Renders `/usr/share/nginx/html/config.js`** from `config.js.template` with all `PUBLIC_*` browser-side variables substituted.
6. **Validates the rendered config** (`nginx -t`) before starting nginx.

If validation fails, the container exits with a clear error message rather than crash-looping.

## Why nginx instead of static hosting

The `Authorization: Bearer ${MORPHEUS_API_KEY}` injection has to happen server-side — it's the whole reason the API key never reaches the browser. A static host (S3 + CloudFront, GitHub Pages, …) cannot do this. The nginx reverse proxy is the simplest mechanism that works.

If you cannot run a container, the next-best alternative is a worker / function tier (Cloudflare Workers, Lambda + API Gateway, …) that proxies `/api/morpheus/...` and injects the auth header. The browser bundle then targets `/api/morpheus/...` on its own origin, same as in the container build.

## DNS resolver caching

The `/api/morpheus/...` location uses a `proxy_pass` *variable* with `resolver … valid=30s` so nginx re-resolves the upstream IP every 30 s. Plain literal hostnames in `proxy_pass` cause nginx to cache the upstream IP forever at config-load time. If your Morpheus upstream rotates IPs (or any DNS-fronted service does), the literal-hostname form breaks until the next container restart.

If you are diagnosing prod chat failures with `checkApiHealth TimeoutError` errors that started suddenly, the first thing to check is whether the container has been running long enough for the upstream IP to have rotated. The variable + resolver form mitigates this; the literal form does not.

## Health checks

A simple HTTP check against `/index.html` is sufficient. The container does not expose a dedicated health endpoint — nginx returning 200 for the SPA shell means `env.sh` succeeded and nginx is serving traffic.

For deeper monitoring, hit `/api/morpheus/...` with a no-op completion request and assert a non-503 response. A 503 from `/api/morpheus/...` specifically means `MORPHEUS_API_KEY` is unset; nginx fast-fails in that case rather than forwarding.

## Persistent storage assumption

`STORAGE_SKU_NAME = 'docker-small'` is hardcoded in `src/config/constants.ts`. When a deploy sets `storage: true`, the executor swaps the requested SKU for `docker-small` regardless of size. If your chain catalog uses a different naming convention (e.g. `docker-disk-small`) or splits storage into a separate SKU, the storage flag will silently miss and your apps will deploy without persistent disk. Update the constant and rebuild the image until Fred exposes storage capability through the SKU API.

## Logging

nginx logs to stdout/stderr. Aggregate them in your usual log pipeline. The interesting access-log entries are:

- `GET /index.html` — initial page load.
- `GET /config.js` — runtime config; one per page load (cached `no-cache, no-store, must-revalidate`).
- `POST /api/morpheus/chat/completions` — every AI chat turn; long-running due to SSE streaming (`proxy_buffering off`).
- `GET /static/...` — hashed static assets, cached `public, immutable`.

There are no Barney-specific logs from inside the SPA — every error in the browser is logged to the console via `logError`. To collect those, instrument the browser separately.

## Updating

```bash
docker pull ghcr.io/manifest-network/barney:1.2.4
docker stop barney && docker rm barney
docker run -d --name barney --restart always -p 8080:80 \
  -e ... \
  ghcr.io/manifest-network/barney:1.2.4
```

Or with compose:

```bash
yq -i '.services.barney.image = "ghcr.io/manifest-network/barney:1.2.4"' compose.yaml
docker compose up -d barney
```

Existing user sessions survive the upgrade — chat history and connected wallets live in the user's localStorage. New page loads pick up the new bundle (the `index.html` and `config.js` responses include `no-cache` headers for exactly this reason).

## Self-building

If you need a custom build:

```bash
docker build -t my-barney \
  --build-arg RELEASE_VERSION=1.2.3 \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  .
```

The build is deterministic given the same lockfile. `RELEASE_VERSION` is stamped into `package.json` before the SPA build (`npm run build-release`); without it the script strips any prerelease suffix from `package.json`'s `version` and appends the short git commit hash (e.g. `0.1.0` → `0.1.0-a1b2c3d`).

The Dockerfile compiles nginx Brotli modules from source against the matching nginx version. This adds about 30 s to the build but produces ABI-compatible modules — Alpine's prebuilt `nginx-mod-http-brotli` targets a different nginx version and is incompatible with the official `nginx:alpine` image.

## CI/CD

The [release workflow](../../.github/workflows/release.yml) runs on tag pushes matching `v[0-9]*.[0-9]*.[0-9]*`:

1. Validates the tag against semver.
2. Builds and pushes a single-platform image (whichever architecture the runner provides — `linux/amd64` on `ubuntu-latest`) to GHCR with semver-derived tags.
3. Publishes provenance and SBOM attestations.
4. Creates a GitHub Release with auto-generated notes and the image digest.

Pre-release tags (`v1.0.0-rc.1`) are flagged as prereleases and skip the `:latest` tag update.

To cut a release, bump the version, tag, and push:

```bash
npm version patch    # or minor / major
git push --follow-tags
```

The workflow does the rest. Only maintainers should push tags.

## Troubleshooting production

| Symptom | Likely cause |
|---------|--------------|
| Container exits at startup with "PUBLIC_MORPHEUS_URL is required" | Variable is unset or empty in the environment |
| Container exits at startup with "must not contain '?' or '#'" | Query string or fragment leaked into `PUBLIC_MORPHEUS_URL` |
| 503 from `/api/morpheus/...` | `MORPHEUS_API_KEY` unset (env.sh's nginx fast-fail) |
| 502 / 504 from `/api/morpheus/...` after running fine | Upstream IP rotated; restart the container if your `nginx.conf.template` predates the `resolver … valid=30s` directive |
| Chat connects but immediately disconnects | Wrong `MORPHEUS_API_KEY` (rotated key, restart needed) |
| Web3Auth network mismatch error | `PUBLIC_WEB3AUTH_NETWORK` doesn't match the client ID's configuration |
| Faucet step always times out on testnet | `PUBLIC_FAUCET_URL` unreachable, or 24-hour cooldown active for the address |
| Provider URLs blocked in dev | Rsbuild dev proxy's `isValidProxyTarget` rejected the URL — see [security.md](security.md) |

For user-facing issues (deploy failures, AI errors), point users at [docs/user/troubleshooting.md](../user/troubleshooting.md).
