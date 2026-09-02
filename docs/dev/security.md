# Security model

This document describes Barney's threat model, the defensive layers it implements, and the responsibilities of each layer. Read it before changing anything that touches network requests, persistence, or input handling.

## Scope and assumptions

**In scope.** This document covers the SPA, the authenticated Morpheus relay (`server/`), and the production proxy (`docker/nginx.conf.template`). The Manifest chain, providers (Fred), the Morpheus inference service, and Web3Auth are external systems with their own threat models — Barney trusts them at the protocol boundary.

**Trust assumptions.**

- The user controls their wallet via Web3Auth. Web3Auth's security is the responsibility of the Web3Auth project.
- The Morpheus API key is held by the operator and never leaves the production server.
- The browser is hostile in the abstract sense — Barney must defend against malicious user input, malicious server responses, and malicious URLs.

**Out of scope.** Browser zero-days, OS-level compromise, supply-chain attacks against npm packages.

## Threat model summary

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Stolen Morpheus API key | Owned only by the Node relay; absent from browser/nginx config, output, logs, and metrics | `server/relay.mjs`, `server/main.mjs` |
| Anonymous use of operator-funded inference | One-time chain/wallet ADR-036 proof followed by a bound HttpOnly session; 401/403 before upstream | `server/auth.mjs`, `src/api/morpheusSession.ts` |
| Signature/session replay | Challenge consumed before verification; short expiry; random server-side session; logout/replacement aborts active calls | `server/auth.mjs`, `server/relay.mjs` |
| Unbounded inference spend | Worst-case durable reservation, per-identity quotas/concurrency, provider hard budget, method/path/model/body/context/output/time ceilings | `server/ledger.mjs`, `server/validation.mjs` |
| Malicious provider URL targeting cloud metadata or private hosts (SSRF) | Multi-layer URL validation (rsbuild dev proxy, runtime `parseHttpUrl` / `isUrlSsrfSafe`, `ai/validation.ts`) | `src/utils/url.ts`, `src/ai/validation.ts`, `rsbuild.config.ts` |
| Malicious chat input attempting prompt injection | Static system-prompt rules; restricted tool set; manifest validation before broadcast | `src/ai/systemPrompt.ts`, `src/ai/toolExecutor/compositeTransactions.ts` |
| Persistent secrets in localStorage | Sensitive env values scrubbed before persistence | `src/registry/appRegistry.ts` (`sanitizeManifestForStorage`) |
| Insecure container env injection (e.g. `LD_PRELOAD`) | Blocklist of dangerous env names rejected before manifest build | `src/ai/toolExecutor/compositeTransactions.ts` (`BLOCKED_ENV_NAMES`) |
| XSS via `<img src>` in chat content | URL protocol validation (`isValidImageUrl`) | `src/utils/url.ts` |
| Prompt injection via tool result content | Tool results are JSON-encoded and not interpreted as instructions; the model is reminded to ignore role-changing instructions | `src/ai/systemPrompt.ts` |
| Stuck pending transactions | Auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` | `src/contexts/AIContext.tsx` |

## Defensive layers

### 1. Paid-relay trust boundary

The browser bundle never contains `MORPHEUS_API_KEY`. The built-in Node relay is the only process that reads it and the only component that creates the upstream `Authorization` header. Production nginx proxies `/api/morpheus/` only to localhost; `server/main.mjs` explicitly removes both relay secrets from nginx's child environment. The development Rsbuild server likewise proxies to the same local relay and never sees the key.

The browser can call only same-origin `/api/morpheus/...` routes. To establish access, it requests a short-lived challenge binding the configured audience, `PUBLIC_CHAIN_ID`, checksummed Manifest wallet address, random nonce, issue time, and expiry. The wallet signs that exact payload with ADR-036. The server verifies the secp256k1 signature and derived Manifest address, consumes the challenge once, and returns a random opaque session only as an `HttpOnly`, `SameSite=Strict` cookie (`Secure` outside local HTTP development). Challenge and session stores keep one entry per wallet and evict oldest entries at their bounded capacities, so an anonymous capacity flood cannot create a global authentication lockout.

Each paid request must also repeat the wallet and chain in headers. The server compares them with the session using constant-time text comparisons and returns 401/403 before parsing or contacting the paid upstream on failure. Sessions live only in server memory: restart, expiry, logout, replacement, disconnect, and wallet switch all require fresh authorization; active streams are aborted on logout/replacement and in the client on wallet change.

Only `POST /api/morpheus/chat/completions` is paid. The relay rejects other methods, paths, query strings, models, and unknown top-level parameters. It reconstructs the upstream body, forces streaming usage reporting, and measures every forwarded field against an exact UTF-8 context-byte ceiling before enforcing output, response, concurrency, connection, total-stream, identity, and provider ceilings. The browser drops oversized old history while retaining its local transcript, preventing one large tool result from wedging future turns.

Before upstream access, an atomic JSON ledger applies realistic estimated-token identity token/spend quotas and reserves a separate byte-level worst-case provider spend amount. Valid provider usage settles both; ambiguous cost units are ignored and configured pricing is used. Missing usage or any uncertain outcome keeps the full reservations. Corrupt state prevents relay initialization. Identity usage is a bounded least-used cache: a newly authenticated wallet evicts the least-spending tracked entry instead of allowing disposable-wallet churn to create a global admission lockout. Late usage for an evicted entry still settles provider accounting, and provider counters are never evicted, so the hard provider budget remains authoritative even though per-wallet counters are best-effort under sustained wallet churn. The ledger contains only HMAC-pseudonymous identities, and metrics aggregate maximum tracked-identity pressure without identity labels.

The direct relay socket and `/metrics` bind only to loopback by default. A deployment may opt into a private container-network bind for Prometheus, but it must not publish that port. Nginx accepts a trusted proxy only as a validated, explicit IPv4 `/32`; wallet identity, not client IP, owns financial controls.

Public errors are fixed messages. Relay logs contain bounded event names, request IDs, and numeric upstream status only—never prompts, wallet addresses, provider bodies, signatures, cookies, or credentials. Metrics use bounded route/outcome/reason labels and likewise expose no identity.

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

Batch deploys use a single immutable consent plan for both UI-direct requests and coalesced model deploys. The card renders each app's image, resources, ports, redacted environment summary, per-app rate, aggregate rate, manifest hash, and batch-plan hash. Removing or editing an entry creates a new validated/priced plan that must be confirmed separately. Immediately before execution, the plan is rebuilt with current chain SKU prices and a fresh aggregate balance; hash, payload, name, provider, or price drift rejects the whole batch before its first broadcast.

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

- **Identity selection before use.** The AI store starts with no selected transcript. `setWalletContext` derives a stable identity from the exact chain ID and trimmed, lowercase wallet address, then atomically loads only that identity's history. Disconnect selects no history. Both initial messages and transaction follow-up model requests fail closed unless the selected history identity matches the active wallet context.
- **Versioned, scoped persistence.** History uses `barney-ai-history:v1:{chainId}:{normalizedAddress}` and a versioned envelope that repeats the identity. `validateChatHistory` validates its messages; malformed, future-version, unversioned, or identity-mismatched scoped data is cleared. The old global `barney-ai-history` key is always discarded because it has no trustworthy wallet owner and is never silently migrated.
- **Streaming messages excluded from persistence.** Half-finished assistant messages don't make it to localStorage; only completed messages do.
- **Retention and deletion.** Each transcript remains in localStorage until its active identity runs `/clear`/uses the settings clear action, the user clears site data, or the browser-global **Save Chat History** preference is disabled. The clear action removes only the active wallet/network transcript; disabling persistence removes all scoped transcripts. AI settings and theme remain global to the browser profile.

## Cosmos-side trust

The Cosmos transaction signing pipeline trusts:

- **manifestjs's generated message types.** Message schemas come from the chain's protobuf definitions; we trust the codegen output.
- **The user's wallet** to sign (or refuse to sign) what cosmjs presents. cosmos-kit shows the rendered message before signing.
- **The RPC node's broadcast** to relay the signed transaction faithfully. A malicious RPC could censor or delay; it cannot forge a signed message.

We do *not* trust:

- Block events alone for state transitions. Barney always re-queries authoritative state (lease status, balances) after a transaction.
- Provider responses for state that lives on chain. The on-chain state wins.

## ADR-036 provider auth

Barney uses ADR-036 for two distinct trust boundaries. The paid Morpheus relay uses the server-issued one-time challenge/session protocol described above. Separately, when Barney calls a tenant provider HTTP endpoint, it mints an ADR-036 token via the SDK's `createAuthTokens` factory (from `@manifest-network/manifest-sdk/deploy`), which is built per wallet address in `src/hooks/useManifestMCP.ts` and threaded through the store as the `authTokens` field of a `SigningContext` (`src/ai/toolExecutor/types.ts`). Provider auth tokens are minted on demand via `authTokens.getAuthToken(leaseUuid)`; lease-data uploads use `authTokens.getLeaseDataAuthToken(leaseUuid, metaHash)` inside `uploadPayloadToProvider` (`src/ai/toolExecutor/utils.ts`). The token includes a timestamp. Replay prevention for those provider tokens is the **provider's** responsibility — it must reject stale or reused timestamps; a client-side check can't prevent replay. Barney ships a client-side freshness helper, `validateAuthTimestamp` (`src/api/provider-api.ts`), but it only avoids *sending* obviously stale/future tokens and currently has no production callers.

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
- **Changes paid inference** — preserve server-side wallet/chain binding, reserve before fetch, keep uncertain reservations charged, and add no prompt/identity/secret labels or logs.

The cost of a missing check is much higher than the cost of redundancy. Lean on existing helpers; do not roll your own validation.
