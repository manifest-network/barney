# Security model

This document describes Barney's threat model, the defensive layers it implements, and the responsibilities of each layer. Read it before changing anything that touches network requests, persistence, or input handling.

## Scope and assumptions

**In scope.** This document covers the SPA itself and the production proxy (`docker/nginx.conf.template`). The Manifest chain, providers (Fred), the Morpheus inference service, and Web3Auth are external systems with their own threat models — Barney trusts them at the protocol boundary.

**Trust assumptions.**

- The user controls their wallet via Web3Auth. Web3Auth's security is the responsibility of the Web3Auth project.
- The Morpheus API key is held by the operator and never leaves the production server.
- The browser is hostile in the abstract sense — Barney must defend against malicious user input, malicious server responses, and malicious URLs.

**Out of scope.** Browser zero-days, OS-level compromise, supply-chain attacks against npm packages.

## Threat model summary

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Stolen Morpheus API key | Server-side injection only; never shipped to browser | `docker/nginx.conf.template`, `rsbuild.config.ts` |
| Malicious provider URL targeting cloud metadata or private hosts (SSRF) | Multi-layer URL validation (rsbuild dev proxy, runtime `parseHttpUrl` / `isUrlSsrfSafe`, `ai/validation.ts`) | `src/utils/url.ts`, `src/ai/validation.ts`, `rsbuild.config.ts` |
| Malicious chat input attempting prompt injection | Static system-prompt rules; restricted tool set; manifest validation before broadcast | `src/ai/systemPrompt.ts`, `src/ai/toolExecutor/compositeTransactions.ts` |
| Persistent secrets in localStorage | Sensitive env values scrubbed before persistence | `src/registry/appRegistry.ts` (`sanitizeManifestForStorage`) |
| Insecure container env injection (e.g. `LD_PRELOAD`) | Blocklist of dangerous env names rejected before manifest build | `src/ai/toolExecutor/compositeTransactions.ts` (`BLOCKED_ENV_NAMES`) |
| XSS via `<img src>` in chat content | URL protocol validation (`isValidImageUrl`) | `src/utils/url.ts` |
| Prompt injection via tool result content | Tool results are JSON-encoded and not interpreted as instructions; the model is reminded to ignore role-changing instructions | `src/ai/systemPrompt.ts` |
| Stuck pending transactions | Auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` | `src/contexts/AIContext.tsx` |

## Defensive layers

### 1. Server-side secret injection

The browser bundle never contains `MORPHEUS_API_KEY`. Both the production nginx config and the Rsbuild dev proxy inject `Authorization: Bearer ${MORPHEUS_API_KEY}` server-side.

**Production (nginx).** `docker/nginx.conf.template` location block `/api/morpheus/`:

```nginx
proxy_set_header Authorization "Bearer ${MORPHEUS_API_KEY}";
```

If `MORPHEUS_API_KEY` is unset at container startup, the location returns 503 immediately (`set $morpheus_key "${MORPHEUS_API_KEY}"; if ($morpheus_key = '') { return 503; }`). This is intentional — it surfaces misconfiguration loudly instead of silently sending unauthenticated requests upstream.

**Development (rsbuild).** `rsbuild.config.ts` adds the same header in `onProxyReq` and 503s if the key is missing.

The browser-side code in `src/api/morpheus.ts` only ever talks to `/api/morpheus/...` — the relative path on the same origin. There is no fallback URL, no client-side header, nothing that could be tampered with to bypass the proxy.

### 2. SSRF protection (multi-layer)

Barney makes outbound requests to provider URLs supplied by the on-chain catalog. Without protection, a malicious provider could target cloud metadata services (e.g. `http://169.254.169.254`) and exfiltrate cloud credentials.

Defense is layered. Each layer makes independent checks because each protects against a different failure mode.

#### Layer A: Rsbuild dev proxy (`isValidProxyTarget`)

The dev proxy at `/proxy-provider` validates the routing target before forwarding. Blocks:

- Non-HTTP(S) protocols.
- URLs with embedded credentials.
- Hostnames matching `metadata.*`, `instance-data.*`, `*.internal`, `*.localdomain`.
- DNS-to-IP wildcard services (`*.nip.io`, `*.xip.io`, `*.sslip.io`) — these can map any DNS name to any IP, defeating IP-literal checks.
- IP literals in dangerous `ipaddr.js` ranges: `linkLocal`, `ipv4Mapped`, `unspecified`, `multicast`, `reserved`, `benchmarking`, `6to4`, `teredo`, `uniqueLocal`.

Localhost and private IPv4 ranges remain *allowed* in dev so you can test against a local provider. This is a deliberate dev-vs-prod asymmetry; production never goes through this proxy.

#### Layer B: Runtime URL validation (`parseHttpUrl` + `isUrlSsrfSafe`)

Used at runtime by `src/api/providerFetch.ts` for every provider URL handed off to fetch. `parseHttpUrl` rejects non-HTTP(S) URLs; `isUrlSsrfSafe` rejects private hosts via `isPrivateHost`.

In dev, `localhost` / `127.0.0.1` / `::1` are explicitly allow-listed (`DEV_ALLOWED_HOSTS`). Other private hosts remain blocked even in dev — the dev allowlist is small and deliberate.

#### Layer C: Hostname classification (`isPrivateHost` in `ai/validation.ts`)

The lowest layer. Uses `ipaddr.js` to parse and classify IP literals against `BLOCKED_IP_RANGES` (loopback, private, linkLocal, multicast, reserved, benchmarking, deprecated, orchid, 6to4, teredo, uniqueLocal, …) and matches hostnames against `INTERNAL_HOSTNAME_PATTERNS` (localhost, .local, .internal, .localdomain, metadata.*, instance-data.*, *.nip.io, *.xip.io, *.sslip.io).

This function is the single source of truth for "is this host dangerous?" Other layers route through it.

### 3. Container env injection blocklist

When the user provides env vars for an image-based deploy, `validateEnvNames` rejects names that would compromise the container or host. The list (`BLOCKED_ENV_NAMES` in `src/ai/toolExecutor/compositeTransactions.ts`) covers:

| Category | Variables |
|----------|-----------|
| Linker injection | `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_PROFILE`, `LD_DEBUG`, `LD_DYNAMIC_WEAK`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` |
| Shell auto-exec | `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `SHELLOPTS`, `BASHOPTS`, `CDPATH` |
| Language runtime injection | `PYTHONPATH`, `PYTHONSTARTUP`, `NODE_OPTIONS`, `NODE_PATH`, `PERL5LIB`, `PERL5OPT`, `RUBYLIB`, `CLASSPATH`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS` |
| Git command injection | `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_SSH` |
| glibc / DNS hijacking | `GCONV_PATH`, `HOSTALIASES` |
| Shell environment | `HOME`, `SHELL`, `IFS` |
| Temp redirection | `TMPDIR`, `TMP`, `TEMP` |
| TLS trust redirection | `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE` |
| Proxy / infrastructure | `http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, `no_proxy`, `NO_PROXY`, `DOCKER_HOST`, `DOCKER_CONFIG`, `KUBECONFIG`, `BUILDKIT_HOST`, `COMPOSE_FILE` |

If the user attaches a manifest file containing one of these names, the deploy is rejected with a descriptive error. Add to the list when new attack vectors are documented; never remove.

### 4. Manifest sanitization

`sanitizeManifestForStorage` in `src/registry/appRegistry.ts` is called every time a manifest is persisted to localStorage. It scrubs values for env keys matching `/password|secret|token|key|credential|api[_-]?key/i`, replacing them with empty strings. The empty value triggers password regeneration on re-deploy.

This is a defense in depth: even if the localStorage data were exfiltrated (via a dev tools share, a backup, or a compromised browser extension), generated passwords are not exposed.

### 5. Transaction confirmation

Every AI-initiated transaction returns `{ requiresConfirmation: true, … }` and surfaces a `ConfirmationCard` with the rendered manifest. The user can edit the manifest, accept, or cancel. The chain transaction is broadcast only after explicit acceptance.

Pending confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 min by default). The cleanup logic lives in `src/contexts/AIContext.tsx`. This protects against stuck UI state where a user walks away mid-confirmation.

### 6. CSP

`index.html` declares a Content-Security-Policy:

```http
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://*.web3auth.io;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https: blob:;
connect-src 'self' https: wss: ws:<%= IS_DEV ? ' http://localhost:* http://127.0.0.1:*' : '' %>;
frame-src 'self' https://*.web3auth.io;
worker-src 'self' blob:;
```

`'unsafe-inline'` and `'unsafe-eval'` are required by Web3Auth and cosmos-kit (both load WASM-flavoured wallet code that requires `eval`). `https://cdn.jsdelivr.net` is allowed in `script-src` because Web3Auth's auth/embed bundles can lazy-load scripts from jsdelivr at runtime — removing it will break social login with no obvious console error. `https://*.web3auth.io` is allowed in `script-src` and `frame-src` for the same flow. The CSP is otherwise restrictive — `default-src 'self'`, no `*` wildcards on script sources.

If you fork Barney and add a third-party script, widen the CSP minimally (specific origin, not `*`) and document the addition.

### 7. Chat history hygiene

- **Validation on load.** `barney-ai-history` is plain JSON validated by `validateChatHistory` (`src/ai/validation.ts`); on `JSON.parse` failure or invalid shape the catch block removes the key and the app starts with an empty history. There is no version envelope and no migration chain — that pattern (`src/utils/versionedStorage.ts`) is used by the account-setup flag, not by the app registry, chat history, or settings.
- **Streaming messages excluded from persistence.** Half-finished assistant messages don't make it to localStorage; only completed messages do.
- **Storage scoping.** The app registry (`barney-apps-{address}`) and the account-setup flag (`barney-refill-{address}`) are keyed by wallet address; chat history (`barney-ai-history`), AI settings (`barney-ai-settings`), and theme (`barney-theme`) are global to the browser profile. Switching wallets isolates per-wallet state but does not clear global state.

## Cosmos-side trust

The Cosmos transaction signing pipeline trusts:

- **manifestjs's generated message types.** Message schemas come from the chain's protobuf definitions; we trust the codegen output.
- **The user's wallet** to sign (or refuse to sign) what cosmjs presents. cosmos-kit shows the rendered message before signing.
- **The RPC node's broadcast** to relay the signed transaction faithfully. A malicious RPC could censor or delay; it cannot forge a signed message.

We do *not* trust:

- Block events alone for state transitions. Barney always re-queries authoritative state (lease status, balances) after a transaction.
- Provider responses for state that lives on chain. The on-chain state wins.

## ADR-036 provider auth

When Barney calls a provider HTTP endpoint, it mints an ADR-036 token via the SDK's `createAuthTokens` factory (from `@manifest-network/manifest-sdk/deploy`), which is built per wallet address in `src/hooks/useManifestMCP.ts` and threaded through the store as the `authTokens` field of a `SigningContext` (`src/ai/toolExecutor/types.ts`). Provider auth tokens are minted on demand via `authTokens.getAuthToken(leaseUuid)`; lease-data uploads use `authTokens.getLeaseDataAuthToken(leaseUuid, metaHash)` inside `uploadPayloadToProvider` (`src/ai/toolExecutor/utils.ts`). The token includes a timestamp; `validateAuthTimestamp` in `src/api/provider-api.ts` is a client-side freshness check that prevents replay.

The signature is over a deterministic payload — the provider can verify the user's wallet ownership without involving the chain.

## Reporting vulnerabilities

Use GitHub's private vulnerability reporting (the **Security** tab → **Report a vulnerability**) on the repository. Do not open public GitHub issues for security reports.

When in doubt about whether something is a security issue, default to private disclosure. We'd rather get a false-positive report than a public CVE.

## Defense-in-depth checklist for new code

When you add code that:

- **Makes a network request to a user-supplied URL** — route it through `parseHttpUrl` + `isUrlSsrfSafe` (or use the dev-proxy adapter, which already does).
- **Persists data to localStorage** — use `versionedStorage` and define a migration path. If the data could include secrets, scrub them like `sanitizeManifestForStorage` does.
- **Accepts env vars from user input** — validate against `BLOCKED_ENV_NAMES`. Add new entries when you find a new dangerous pattern.
- **Renders user-controlled HTML or URLs** — go through `isValidImageUrl` or equivalent. Never inject raw HTML from untrusted sources; rely on React's default text-escaping behaviour.
- **Calls a chain transaction** — make sure the user confirms via `ConfirmationCard`. Never broadcast in `executeXxx`; broadcast only in `executeConfirmedXxx`.
- **Adds a third-party script or origin** — widen the CSP in `index.html` minimally and document.

The cost of a missing check is much higher than the cost of redundancy. Lean on existing helpers; do not roll your own validation.
