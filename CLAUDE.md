# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server (Rsbuild)
npm run build        # Type check + production build
npm run build-release # Stamp version + build (Docker/CI)
npm run lint         # ESLint
npm test             # Run all tests (Vitest)
npm run test:watch   # Tests in watch mode
npm run test:coverage # Tests with coverage report
npm run preview      # Preview production build locally
npm run postinstall  # Apply patches (runs automatically after npm install)
```

Run a single test file:
```bash
npx vitest run src/utils/hash.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "validateFile"
```

Tests use Vitest with `happy-dom` (not jsdom). Coverage uses the `v8` provider. See `vitest.config.ts`.

## Architecture

### UI Layout

Chat-primary deployment platform:

```
ErrorBoundary
  └─ ThemeProvider (next-themes, 7 themes registered)
      ├─ MatrixRain (renders the canvas only when theme === 'matrix'; returns null otherwise)
      └─ ChainProvider (cosmos-kit wallet abstraction)
          └─ ToastProvider (toast notifications)
              └─ AIProvider (chat state, tool execution, Morpheus streaming)
                  ├─ AppShell
                  │   ├─ AccountSetupOverlay (blocking stepper during first-connect provisioning)
                  │   ├─ LandingPage (when not connected)
                  │   └─ MainLayout (when connected)
                  │       ├─ useRegistryReconciliation (mounted here, OUTSIDE the sidebar's ErrorBoundary)
                  │       ├─ useAppRecovery (mounted here, OUTSIDE the sidebar's ErrorBoundary)
                  │       ├─ useDnsStatusPolling (mounted here, OUTSIDE the sidebar's ErrorBoundary)
                  │       ├─ ErrorBoundary (sidebar isolation)
                  │       │   └─ AppsSidebar (wallet, credits, running apps)
                  │       ├─ AIErrorBoundary
                  │       │   └─ ChatPanel (messages, input, settings)
                  │       │       ├─ MessageBubble (per-message rendering)
                  │       │       │   └─ StreamingText (typewriter effect with link detection)
                  │       │       ├─ ProgressCard (during deploy)
                  │       │       ├─ AppCard (app overview / deploy success — MessageCard `app`; secondary domain management)
                  │       │       ├─ ConfirmationCard (TX approval; covers deploy/restart/update/stop/fund/set_custom_domain)
                  │       │       │   ├─ ManifestEditor (single-service manifest editing)
                  │       │       │   └─ StackManifestEditor (multi-service stack editing)
                  │       │       ├─ LogCard (tool result for `get_logs`)
                  │       │       ├─ CustomDomainCard (single-domain status / multi-domain consolidated / no-domain form)
                  │       │       │   └─ DomainRow (cross-cutting atom — also used by sidebar tooltip and AppCard's deploy-success row)
                  │       │       ├─ HelpCard (/help display)
                  │       │       └─ AISettings (inline settings panel)
                  │       └─ Modal (keyboard-shortcuts help, opens on `?`)
                  └─ ToastContainer (toast rendering)
```

`AppShell` (`src/components/layout/AppShell.tsx`) is the top-level router. It atomically syncs wallet state (clientManager, address, chain, and a `signing` SigningContext) from cosmos-kit into the AI store via `setWalletContext`.

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AI Store** (`src/stores/aiStore.ts`) - Zustand store managing chat state, streaming, tool execution, and wallet refs. Actions in `src/stores/aiActions/`.
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-sdk`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Dispatches to composite executors:
   - **Entry point** (`index.ts`): Contains `QUERY_TOOLS`/`TX_TOOLS` sets and `executeTool()` dispatcher
   - **Types** (`types.ts`): `ToolResult`, `ToolExecutorOptions`, `PayloadAttachment`, etc.
   - **Query tools** (`compositeQueries.ts`): Execute immediately — `list_apps`, `app_status`, `get_logs`, `get_balance`, `browse_catalog`, `lease_history`, `app_diagnostics`, `app_releases`, `request_faucet`
   - **TX tools** (`compositeTransactions.ts`): Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts — `deploy_app`, `stop_app`, `fund_credits`, `restart_app`, `update_app`, `set_custom_domain`. `deploy_app`/`batch_deploy` delegate the create-lease → (set-domain) → upload → provision-poll spine to the SDK's `deployManifest` primitive (ENG-279 deploy-path rewrite); barney keeps the plan phase, registry state machine, progress UI, and URL shaping around it. Deploy-path helpers live here: `buildFredAuthCtx` (assembles the `FredAuthCtx` deployManifest needs), `classifyLeaseChainState` + `handleDeployManifestError` (post-throw error handler, in `deployError.ts`). `TerminalChainStateError` records both `chainState: 'absent'` and `provisionState: 'failed'`, preserving access to failure diagnostics. For other post-lease throws, the SDK's readiness-unconfirmed flag/code records `provisionState: 'unconfirmed'`. A `partial: true` error with no `failedStep` or with `set_domain`/`upload` records `provisionState: 'failed'` because no manifest was uploaded; the missing-step case includes callback failures as well as cancellation. A partial `poll` error without the readiness flag records the provider's failure verdict and fetches diagnostics. All other partial steps, including unknown or malformed values, record `provisionState: 'unconfirmed'`. Only throws without a readiness verdict or `partial: true` reach the `getLease` fallback. An ACTIVE lease alone cannot establish workload readiness, so no partial throw is promoted to live by a chain read.
   - **Batch deploy plan** (`batchDeployPlan.ts`): The canonical planner for both UI-direct batches and multiple model `deploy_app` calls coalesced by `toolExecution.ts`. It owns name/tier/provider resolution, manifest/domain validation, per-service pricing, aggregate affordability, redacted display summaries, exact manifest hashes, and the stable batch-plan hash. Both initial consent and confirm-time integrity plans resolve the active chain SKU catalog; independent domain checks run concurrently and every network wait observes the workflow abort signal. The deeply frozen plan is the consent artifact consumed by `ConfirmationCard`; edits/removals build a new plan and require a second confirmation, while a rejected edit re-plan keeps the same mounted drafts for correction. Confirmed execution verifies the hash, rebuilds the same plan with a fresh aggregate balance, and rejects any price/provider/name/payload drift before the first broadcast.
   - **Batch runner** (`batchRunner.ts`): Shared bounded concurrency, signing mutex, progress and result summaries for deploy/restart. Results keep `succeeded`, `failed`, `unconfirmed`, and `cancelled` separate. Unqueued entries are cancelled; cancellation after submission does not imply nothing happened. Restart/update uncertainty renders under `Outcome unknown` with terminal `unconfirmed` progress, including per-app rows; it never paints a successful restart. Deploy retains its `Still deploying` summary contract. `success: true` on a mixed/unknown batch means the tool returned a structured summary, not that every command succeeded; only `succeeded` identifies confirmed operations. SDK primitives must never be wrapped in a caller-side signing lock.
   - **Failure guidance** (`failureGuidance.ts`): `nextStepFor(reason, appName)` — the **single source of truth** for every next-step string barney shows. Relays the SDK's curated `FRED_REASON_GUIDANCE[reason].nextStep` verbatim except for `ContainerExited` / `Unknown` / `RestoreFailed`, whose SDK sentences name `get_logs({ lease_uuid, tail: 200 })` and `restore_app` — a call shape barney's `get_logs(app_name)` rejects and a tool barney does not have. Those three keep the SDK's tool-free `explanation` as their lead and substitute only the actionable half. Gates **only** on `isKnownFailureReason` (fred's reason set is open and add-only): an unrecognized/absent reason yields `undefined` — omit the next step, never fake one — while `reason` itself is still relayed verbatim. Three sinks, all wired here: `app_diagnostics` (`compositeQueries.ts`), the deploy-failure prose (`deployError.ts`), and the update-failure copy (`compositeTransactions.ts`). Never call the SDK's `guidanceFor` directly from a display site
   - **Helpers** (`helpers.ts`): Shared functions — `extractPrimaryServicePorts`, `formatConnectionUrl`, `deriveUrlFromConnection` (shapes the app URL from `DeployResult.connection` with no extra round-trip), `failureText` (the single display-boundary rendering of a fred failure pair: `failureDetail` for dual-era `reason`/`message` ↔ `last_error`/`error`, then `sanitizeForDisplay`)
   - **Provision status** (`provisionStatus.ts`): the **single** reading of fred's `provision_status`, shared by `app_status` (`compositeQueries.ts`) and the update rollback gate (`compositeTransactions.ts`) — the two had each hand-maintained a status set and had already drifted. `classifyProvisionStatus(status)` → registry `provisionState`; `isUnsettledProvisionStatus(status)` → "carries no verdict", derived as SDK `PROVISION_IN_PROGRESS` **minus** the failure verdicts so a status a newer fred adds reaches both consumers at once. `failing` is a **verdict** here even though the SDK lists it under `PROVISION_IN_PROGRESS`: that set is a POLL rule (keep waiting for the settle to `failed`), while fred enters `Failing` only from `Ready` on `evContainerDied` and stamps `Reason: ContainerExited` synchronously. An unmodelled value is deliberately NOT unsettled — fred's vocabulary is open and add-only, so the default is "trust the verdict that came with it", not silence; an ABSENT status IS unsettled (`omitempty` drops it when a degraded provider's provision lookup fails)
   - **ADR-036 auth**: consolidated to a single `createProviderAuth` minter built once at the `useManifestMCP` root (`src/hooks/useManifestMCP.ts`). `authTokens` is a thin address-binding adapter over that same instance (`src/hooks/authTokensAdapter.ts`); `providerAuth` and the separate server-challenge signer `relayAuth` are required fields on `SigningContext`. `deployManifest` handles payload upload + SHA-256 hashing internally, so barney's old `toolExecutor/utils.ts` (`uploadPayloadToProvider` / `computePayloadHash`) was deleted
   - **Advanced query**: `cosmos_query` is handled separately and is read-only. Unknown model tools and unknown confirmed tools fail closed.
   - **Internal pseudo-tool**: `batch_deploy` — orchestrates multi-app deploys. Not declared in `AI_TOOLS` and never called directly by the model; it is synthesized by the UI's `requestBatchDeploy` action and when `toolExecution.ts` coalesces multiple model `deploy_app` confirmations, then routed through `executeConfirmedTool` (case `'batch_deploy'`)

### 16 Composite Tools

| Tool | Type | Description |
|------|------|-------------|
| `deploy_app(app_name?, size?, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?, custom_domain?, service_name?)` | TX | Deploy from attached manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image`. `custom_domain` attaches a domain in the same TX flow (single-step deploy + DNS); `service_name` picks the target service in a multi-service stack. The `size` enum is rebuilt at prompt-build time from the resolved SKU tier list (chain ∩ `PUBLIC_SKU_SPECS`); default size is the cheapest available tier (lowest normalized `$/hour` via `getCheapestTier(tiers)` in `src/api/skuTiers.ts`). The executor resolves size via `resolveSizeOrCheapest`: an omitted **or unavailable** size falls back to the cheapest tier; it returns `Tier catalog unavailable — try again in a moment.` only when the resolved tier list is empty |
| `stop_app(app_name)` | TX | Stop apps by name, comma-separated list (e.g. "redis,postgres"), or "all" to stop all running apps |
| `fund_credits(amount)` | TX | Add credits in display units |
| `restart_app(app_name, new_command?)` | TX | Restart a named app, comma-separated selection, or all eligible apps. On PR240, recover pending restarts with their saved command keys; `all` recovers only unresolved active items when any remain. A persisted receipt blocks stale retry advice only when recovery guidance was issued; routine settled commands allow ordinary follow-up work; `new_command:true` requires deliberate new intent and never bypasses pending work. Ignore chain-absent leases, isolate unreadable records per selected app, and refuse to replace a pending update with a restart. Readiness and operation outcome are separate: a restored healthy runtime may retain a failed restart diagnostic. |
| `update_app(app_name, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?, new_command?)` | TX | Update from an attached manifest, image, or service stack (`services` excludes `image`). PR240 recovery retains the exact final manifest bytes and command key, including after a lost response; reconstructing a different payload is refused while unresolved. A receipt for a previously uncertain command requires explicit new-command planning; directly reported ordinary outcomes do not. Correlate fresh release history and diagnostics separately from workload readiness. The legacy v0.13 path retains its post-update provision verdict gate. |
| `set_custom_domain(app_name, custom_domain, service_name?)` | TX | Attach, change, or clear (`custom_domain=""`) a per-LeaseItem custom domain. Surfaces a `CustomDomainCard` post-broadcast with DNS status polling |
| `list_apps(state?)` | Query | Discover and list apps (default: running and deploying; explicit state filters remain exact). Re-observes the chain for EVERY app in BOTH directions — records `chainState: 'active' \| 'pending' \| 'absent'` rather than only latching the negative — and keeps PENDING distinct from ACTIVE (a pending lease derives `deploying`, not `running`). Never touches `provisionState`: it has no provider evidence |
| `app_status(app_name)` | Query | Detailed status: registry + chain + fred. Records BOTH observations it makes — `chainState` from the chain lease (`active`/`pending`/`absent`, the PENDING branch matching `list_apps` and `reconcileWithChain`) and `provisionState` from fred's `provision_status` (via `classifyProvisionStatus`: the SDK's `PROVISION_SUCCESS` → `confirmed`, `PROVISION_FAILED` → `failed`, `PROVISION_IN_PROGRESS` and `retained` → `unconfirmed`, anything in none of those sets → no observation). An in-flight reading fills a gap but preserves existing `confirmed` and `failed` verdicts; it sets `readinessStale` so bounded background checks follow the runtime. `retained` records `unconfirmed`, because the workload really is gone. Always emits an `AppCard` overview with status, endpoint, and stack connections. Unavailable status and cached endpoints are labeled explicitly. Eligible domain setup/management opens a secondary `CustomDomainCard` within the overview |
| `get_logs(app_name, tail?)` | Query | Container logs for an app. Refuses **only** `stopped` apps (the lease is gone, so the lease-scoped ADR-036 token authenticates against nothing) — the same single refusal rule `app_diagnostics` and `app_releases` use. A `failed` or `deploying` app is served: fred keeps the lease and its containers through a failed provision, and that is exactly when logs are wanted |
| `get_balance()` | Query | Credits, spending rate, time remaining |
| `browse_catalog()` | Query | Providers + SKU tiers with health checks. Each provider row carries `healthy` (true only for the exact verdict `healthy`), plus `health_status` (the validated provider verdict, or `unreachable` / `no_api_url` / `invalid_response`). `healthError` summarizes failing checks or carries the bounded, sanitized SDK diagnostic for valid JSON that violates the response schema (`invalid_response`). Transport failures and unparseable JSON bodies (`invalid_json`, including an HTML body returned with HTTP 200) use the `unreachable` fallback without `healthError`. The provider verdict tier is an OPEN set — echo it verbatim, never `switch` on it |
| `lease_history(state?, limit?, offset?)` | Query | Paginated on-chain lease history with state filtering |
| `app_diagnostics(app_name)` | Query | Provision diagnostics: status, fail count, and the failure pair — `reason` + `message` (fred ENG-508), with the deprecated `last_error` still echoed when a pre-v0.13.0 provider sends it, plus `next_step` when `nextStepFor` (see `failureGuidance.ts`) has barney-shaped guidance for that reason. Refused only for a `stopped` app; a `failed` app is exactly when diagnostics are wanted |
| `app_releases(app_name)` | Query | Release/version history for an app. Same refusal policy as `app_diagnostics`: only a `stopped` app is refused — a `failed` app still has a release history, and that history is what tells the user which version the provider is actually running (the ENG-619 indeterminate-update copy points here) |
| `request_faucet()` | Query | Request free PWR (gas + credits) and MFX tokens from the faucet (24-hour cooldown per token) |
| `cosmos_query(module, subcommand, args?)` | Query | Raw chain query escape hatch |

Tool definitions: `src/ai/tools.ts` (static base `AI_TOOLS` + `buildAITools(tiers)` builder — the builder is what `sendMessage` ships to the model, with `deploy_app.size.enum` injected from the resolved tier list; passing `[]` omits the enum so the executor's "Tier catalog unavailable" rejection is the single failure mode). System prompt: `src/ai/systemPrompt.ts` (signature is `getSystemPrompt(address?, tiers?)` — the tier block is rendered from `tiers`). Known Docker images and stacks: `src/ai/knownImages.ts`. In-app `/help` content: `src/ai/helpText.ts` (signature is `buildHelpText(skuTiers: SkuTiersState)` — the resource-tiers table is rendered from `skuTiers.tiers`; an empty list produces phase-distinct copy: `error` → "Tier catalog unavailable: \<error\>"; `loading` → loading status row; `idle` → "not loaded yet"; defensive empty `ready` → "no tiers configured").

### Manifest Generation (`src/ai/manifest.ts`)

Thin wrappers around the SDK deploy facade's manifest builders (`@manifest-network/manifest-sdk/deploy`), adding Barney-specific behavior: port string normalization, password generation for empty env values, tmpfs/expose string splitting, SHA-256 payload hashing, and `BuildManifestResult` wrapping.

- `buildManifest(opts)` — Build single-service manifest JSON, compute hash, return `BuildManifestResult`. Delegates to fred's `buildManifest()`
- `buildStackManifest(opts)` — Build multi-service stack manifest with `{ services: {...} }` format, compute hash
- `mergeManifest(newManifest, oldManifestJson)` — Merge old manifest fields into new, graceful fallback on parse error. Delegates to fred's `mergeManifest()`
- `validateServiceName(name)` — RFC 1123 DNS label validation, returns error string or null. Wraps fred's boolean return
- `normalizePorts(port)` — Delegate port-string parsing to the SDK; `PortOptions` aliases its exported `PortConfig`
- `deriveAppNameFromImage(image)` — Extract app name from Docker image ref (Barney-local, different from fred which includes tags)
- `isStackManifest(manifest)` / `parseStackManifest(json)` / `getServiceNames(manifest)` — Stack manifest utilities (Barney-local, use `{ services: {...} }` format vs fred's flat format)
- `ServiceConfig` — Type alias for `BuildManifestOptions`, used per-service in stacks

### Known Images & Stacks (`src/ai/knownImages.ts`)

- `KNOWN_IMAGES` — Readonly array of known Docker image configs with default ports, env, user, tmpfs, health_check, etc.
- `findKnownImage(imageRef)` — Lookup known image config by Docker image reference
- `KNOWN_STACKS` — Readonly array of pre-built multi-service stack configs (WordPress, Ghost, Adminer-Postgres) with `depends_on` ordering and aliases (e.g., `wp`, `pgadmin`). The stack parser matches service roles and injects `service_healthy` defaults only for targets with an active health check, preserving ordering for alternative database images. Explicit user dependencies are retained for SDK validation
- `findKnownStack(name)` — Lookup known stack by name or alias
- `generateImageReferenceForPrompt()` / `generateStackReferenceForPrompt()` — Generate reference text injected into the AI system prompt

### App Registry

`src/registry/appRegistry.ts` — wallet-scoped app cache with optional localStorage persistence and an in-memory fallback. Unsaved local writes remain authoritative across cross-tab storage events until a local save succeeds. Later registry writes retry persistence; reads and no-op updates do not retry. Saves replace the whole wallet array without merging other tabs, so concurrent aliases/manifests can be overwritten even though live inventory is recoverable from chain. `discoverAppsFromChain` imports missing active/pending leases with stable lease-derived names and unconfirmed readiness, deriving status through `deriveAppStatus`. Sidebar reconciliation and `list_apps` both discover inventory after clearing browser storage. `src/api/appDiscovery.ts` resolves missing catalog metadata; `useAppRecovery` independently reads authenticated provider status/connections. Within a recovery attempt, the status request starts as soon as its token is ready, before the second authentication for connection details. A completed status verdict survives second-mint rejection or timeout unless the caller cancels or the registry snapshot changes. An unresolved mint pauses later background attempts using the same auth-token service until it settles. Complete paginated tenant reads prevent a truncated page from marking leases absent. Discovery/deploy races merge by lease UUID; stale provider reads cannot overwrite a newer registry snapshot.

Original friendly names and manifest bodies are unavailable through the current chain/provider APIs. They remain optional local metadata. Image-based partial updates require a cached manifest; a complete attached manifest or full services replacement can update a recovered app.

```
Key: barney-apps-{address}
AppEntry { name, leaseUuid, size, providerUuid, providerUrl, createdAt, url?, connection?, connectionStale?, readinessStale?, manifest?, customDomains?,
           status, chainState?, provisionState? }
  connection? { host, fqdn?, ports?, instances?: { fqdn?, ports? }[], metadata?, services? }
AppStatus:      'deploying' | 'running' | 'stopped' | 'failed'   (DERIVED — never written directly)
ChainState:     'active' | 'pending' | 'absent'        (absent field = never observed)
ProvisionState: 'confirmed' | 'unconfirmed' | 'failed' (absent field = never observed)
```

`status` is a **derived** summary, not a written one (F4). The two optional observation fields are
what writers set: `chainState` is what the CHAIN last said about the lease, `provisionState` is what
the PROVIDER last said about provisioning. Both being optional is load-bearing — an absent field
means "never observed" (the Kubernetes conditions `Unknown`), which is exactly what every
pre-refactor localStorage entry legitimately is. `deriveAppStatus` is the single derivation point
and runs on every mutation (`discoverAppsFromChain`, `addApp`, `updateApp`, `reconcileWithChain`), so the ~86 `.status` read
sites are untouched. Precedence: provider `failed` → `failed`; chain `absent` → `stopped` (a legacy
entry already recorded `failed` stays `failed`); provider `unconfirmed` → `deploying`; provider
`confirmed` → `deploying` if the chain is `pending`, else `running`; with no provider observation,
chain `active` → `running`, `pending` → `deploying`, nothing → the stored legacy `status` verbatim.

`reconcileWithChain` observes ONE thing and writes ONE field (`chainState`). It contains no
status-promotion branch: a chain lease being ACTIVE says nothing about whether the provider ever
provisioned the workload (fred v0.13.0 `internal/provisioner/reconciler.go` only closes a failed
lease after `FailCount >= maxReprovisionAttempts`), so the old `failed → running` /
`deploying → running` promotions reverted the deploy path's provider verdicts within one 15s
registry-reconciliation tick.

**Observations must be REFRESHABLE, not one-way latches.** A field a writer can set but never
re-clear is a latch, and a latch defeats the level-triggered model this refactor exists to build
("fields in status should be the most recent observations of actual state"). The re-observation
points, by field:

| Field | Re-observed by | Cadence |
|-------|----------------|---------|
| `chainState` | `reconcileWithChain` (`useRegistryReconciliation`), `list_apps`, `app_status` | 15s timer + on tool call |
| `customDomains` | `reconcileCustomDomainsWithChain` (`useRegistryReconciliation`), `app_status` | 15s timer + on tool call |
| `provisionState` | `app_status`, `useAppRecovery` | on tool call + bounded background recovery |

One recovery driver selects one app at a time, with a total request deadline and a separate token
per endpoint. It yields to chat, confirmations, and transactions, and aborts on wallet changes.
Incomplete responses retry with per-app backoff (15s, 30s, 60s) up to four attempts for an unchanged
snapshot. Uncertain readiness after maintenance or an arrived, unsettled Fred status response, and
confirmed apps with saved, invalidated connection inventory, get four additional attempts at
five-minute intervals (eight total). Ordinary failed status reads do not create readiness staleness;
reconciling a pending maintenance command can still require follow-up when its provision read or
authentication fails. The readiness flag
keeps that allowance after foreground connection refreshes and reloads; other missing inventory
keeps the four-attempt limit. Every attempt
checks readiness as well as connections. The allowance can grow from four to eight when readiness
is uncertain after maintenance or an arrived response, or when confirmed inventory is saved and invalidated, without resetting used attempts. It never shrinks
across the driver's own partial observations, and the slow retry cadence stays fixed. A failed verdict
or confirmed workload with an explicit empty port inventory retires once pending readiness is resolved;
missing URLs alone do not cause endless signing. `app_status` remains the explicit refresh path
after retirement or exhaustion. Provider work never gates chat listing or chain reconciliation.

**`updateApp` splits PERSIST from NOTIFY**, which is what makes re-observation affordable at all.
`dirty` (any real value change) decides whether to write; `visible` decides whether to `notify`.
A write touching only `OBSERVATION_ONLY_FIELDS` (`chainState`, `provisionState`, `readinessStale` —
fields no subscriber renders) persists **silently** unless it moves the derived `status`; a write that changes
nothing does nothing at all — no `JSON.stringify`, no localStorage write, no notify. Without the
split, a writer on a 15s timer could only afford to record the NEGATIVE observation, which is
precisely how the latch arose. Cross-tab storage events use the same visibility rule when both
complete snapshots validate: observation-only differences invalidate the read cache without notifying
UI subscribers. Changed visible fields or derived status, creation/removal, reordering and invalid
snapshots still notify. Unsaved local changes remain authoritative until persistence succeeds.
Two rules for anyone extending `AppEntry`:

- `OBSERVATION_ONLY_FIELDS` is a **deny-list**: a new field defaults to NOTIFYING. Silence must be
  opted into by someone who has checked the two subscribers (`AppsSidebar`, `useRegistryApps` →
  `useDnsStatusPolling`). An extra notify is a redundant re-render; a missing one is a surface that
  never updates.
- `STRUCTURAL_FIELDS` (`customDomains`, `connection`) are compared by VALUE, not reference, because
  `app_status` rebuilds both from scratch on every call. Under `Object.is` they read as "changed"
  every time, and the resulting notify is not merely wasteful: `useRegistryApps` rebuilds its array,
  `useDnsStatusPolling` memoizes `allTargets` on that reference, and its cleanup effect **aborts
  every in-flight DoH/HTTPS probe**. Re-running `app_status` to check on a pending domain used to
  cancel the very probe that would have answered. Any future field a repeatable writer rebuilds
  belongs in this set.

`connectionStale` is a notifying scalar: changing it invalidates or restores the DNS evidence
rendered by subscribers. The independent `readinessStale` flag schedules bounded runtime
observation after uncertain maintenance or an arrived, unsettled status response, including for previously
failed apps. Its changes persist without notifying UI subscribers or interrupting DNS probes;
`useAppRecovery` reads the registry on its own tick. During ordinary status reads and discovery, a
rejected status fetch or token mint leaves the flag unchanged. `app_status` and `app_releases` also reconcile pending
maintenance when present; that command still needs a runtime observation if its separate provision
read or authentication fails, so reconciliation can set the flag and grant the eight-attempt allowance. An arrived response with omitted, empty or unmodelled status still schedules follow-up. Fresh connection
data clears only connection staleness; a fresh runtime verdict clears readiness staleness. `customDomains` and `connection` are notifying structural fields.

Functions: `getApps`, `getApp`, `findApp`, `getAppByLease`, `discoverAppsFromChain`, `addApp`, `updateApp`, `removeApp`, `reconcileWithChain`, `reconcileCustomDomainsWithChain`, `deriveAppStatus`, `validateAppName`, `sanitizeManifestForStorage`.

Name rules: lowercase, alphanumeric + hyphens, 1-32 chars, unique per wallet.

### Deploy Progress

`src/ai/progress.ts` defines `DeployProgress` with phases:
`creating_lease → uploading → provisioning → ready | failed`
Additional phases for restart/update operations: `restarting`, `updating`, and terminal `unconfirmed` (neutral outcome-unknown display).
The `operation` field (`'deploy' | 'restart' | 'update'`) indicates the current operation type for UI display.

Progress is reported via `onProgress` callback in `ToolExecutorOptions`, stored in the AI store as `deployProgress`, and rendered by `ProgressCard`. Batch deploys include a `batch` array with per-app progress.

### Fred API Client

`src/api/fred.ts` — thin HTTP-function wrappers for lease deployment status.

The five wrappers (`getLeaseLogs`, `getLeaseProvision`, `getLeaseReleases`, `restartLease`, `updateLease`) delegate to the SDK deploy facade (`@manifest-network/manifest-sdk/deploy`) with Barney's CORS proxy/SSRF `fetchFn` adapter (`src/api/providerFetchAdapter.ts`) + the DEV `allowLoopback` flag injected. Use `getLeaseLogs`, never `getAppLogs` (the latter's 4000-char cap clips the full-logs LogCard). As of ENG-774 `restartLease` / `updateLease` are no longer on any app path — `restart_app` / `update_app` go through the SDK's `restartApp` / `updateApp` primitives (see Transaction Path); the two wrappers remain as the raw HTTP escape hatch.

The live lease-status WebSocket path is no longer barney-local (ENG-312 Phase 6): restart/update wait via the SDK's `waitForLeaseStatus` with an injected browser `EventTransport` (`src/api/eventTransport.ts`) — the SDK owns reconnect/backoff/liveness/poll-fallback; `eventTransport.ts` only reshapes the URL for the dev `/proxy-provider` tunnel (prod connects direct, SSRF-validated) and adapts the native `WebSocket` to the SDK's `EventSocket`.

### Transaction Path

All mutations use typed SDK operations. `transactionPlans.ts` validates and freezes semantic confirmation data during planning and parses it again before execution. `MAX_TRANSACTION_GAS` (50,000,000) is passed to the wallet manager; `transactionFees.ts` derives the displayed maximum network fee from that ceiling and `GAS_PRICE`. Raw fee/transaction overrides are rejected. Web3Auth has no second approval dialog: the human consent boundary is `ConfirmationCard` plus the store/executor identity checks. See [transaction inventory](docs/dev/transaction-boundary.md) and [security](docs/dev/security.md#5-transaction-confirmation).

SDK 0.23 validates domain syntax before creating a paid lease and validates the final update payload before provider authentication/POST. Its deploy catch now includes `onLeaseCreated`: a partial error without `failedStep` means the manifest was never uploaded, including non-cancellation callback failures. Deploy, restart (including batches), and update wrap progress observers with `createProgressReporter` so synchronous throws and asynchronous rejections cannot interrupt these operations. Unknown partial steps remain unconfirmed. See the transaction inventory for the exact preflight checks.

URL shaping distinguishes missing port records from records emptied by SDK validation. An emptied record cannot establish HTTP routing from an FQDN; independent status endpoints remain usable. Instance HTTP FQDNs can route through Traefik without a published host port, while instance TCP mappings retain the reported Docker host. `connectionPatch` preserves stored connection inventory when a read supplies only a URL. `resolveAppEndpoint` preserves saved DNS and qualified endpoints while composing assigned ports onto legacy bare IPv4 addresses, consistently across status and lifecycle results. `refreshAppConnection`, shared by `app_status` and background recovery, also preserves the established URL when the connection read fails: a status-only IP:port hint cannot downgrade it. Status endpoints remain a fallback when no endpoint is known or a returned connection is unshapeable. During an outage, a differing status endpoint is offered separately as a provider-reported address without persisting it over the established URL. A returned connection replaces old inventory independently of whether it yields a URL; an empty or unassigned inventory must not leave old ports displayed as current. Failed connection reads retain cached service details in a collapsed disclosure. Chain-only queries label saved access details without presenting a failed-refresh warning. Connection normalization supports persisted Docker port formats and assigns flat data only to a sole known service; current chain service names take precedence over the manifest and filter obsolete cached services. All app-card producers use this normalization. Empty service records and unassigned port-zero mappings show "No published ports" instead of an unavailable-data warning. AppCard subscribes only to its own DNS entry. Attached-domain controls remain available for PENDING and ACTIVE chain leases, including when the provider reports a failed workload; terminal leases hide those controls. Stop eligibility follows the chain verdict, so a failed workload on an active lease can be stopped while a legacy failed entry on a closed lease cannot. Clicking an outdated Stop card explains that no active lease remains instead of silently returning; Stop does not depend on relay health.

Sidebar status checks use `requestAppStatus` to query directly without a model round-trip. The action bypasses cached results, is independent of Morpheus relay health, records the real tool exchange for chat context, and guards cancellation and wallet transitions. `withAbort` stops awaiting on cancellation without shortening the SDK query deadlines; error classification uses the thrown reason. Confirmed dispatch invalidates query caches before any mutation, including operations that later fail ambiguously. Model-initiated `app_status` results opt into continuation; every display card in a batch must opt in, and confirmations still end the turn. `displayProvisionStatus` in `provisionStatus.ts` owns display availability: only absent/empty readings are hidden and produce no provision-state observation. An explicit `unknown` reading remains visible and classifies as `unconfirmed` when no verdict exists, preserving previous `confirmed` or `failed` verdicts while setting `readinessStale`. Foreground status, maintenance, and background hydration share that patch. Provider progress is shown separately from the durable registry verdict, and bounded background reads follow it to readiness or failure. Lease status and workload availability are distinct: an ACTIVE chain reading keeps the recorded badge visible with a workload-unavailable detail if the provider did not answer. Sidebar selection closes the mobile panel through a synchronous acceptance callback after publishing the chat placeholder. Accepted requests show progress, cancellation, and errors in chat; only start refusals remain in the sidebar. Desktop selection preserves focus using `aria-disabled` only during its own status request; ordinary chat does not announce sidebar guidance. Clicking during another request or confirmation explains the refusal. That feedback is cleared when its blocker ends, so later unrelated actions do not revive it. Historical Stop cards also explain busy and wallet-transition refusals. Model tool cancellation finalizes every advertised tool reply, including unstarted calls and collected confirmations, before ending the turn. Provider progress is sanitized and bounded for display; classification still matches raw values.

The TX path splits by tool:

- **`deploy_app` / `batch_deploy`** — delegate to the SDK's `deployManifest` primitive (imported from the `@manifest-network/manifest-sdk/deploy` facade), which runs create-lease (via `cosmosTx` internally) → optional set-domain → payload upload → provision-poll as one call. barney no longer hand-rolls this spine.
- **`stop_app`** — the SDK's `stopApp(ctx, { leaseUuid }, opts)` primitive from `@manifest-network/manifest-sdk/deploy` (ctx is a `TxCtx` = `{ chain: clientManager, logger: noopLogger }`). It pre-queries the authoritative on-chain state and dispatches ACTIVE→close-lease / PENDING→cancel-lease / terminal→no-op, so idempotency is internal (`outcome: 'already_inactive'`) — barney no longer string-matches a `rawLog`. Single stop uses `waitForConfirmation: true` (blocks for the authoritative outcome); bulk "stop all" uses `waitForConfirmation: false` (async SYNC/CheckTx broadcast, hash-only) so it doesn't serialize N block confirmations — the registry is marked `stopped` optimistically and `reconcileWithChain` corrects any DeliverTx-level failure later.
- **`fund_credits`** — `fundCredits(ctx, { amount }, { signal, waitForConfirmation: true })` from the SDK deploy facade. The typed consent plan contains only the PWR display amount and authorized wallet address. Planning and confirmation share the same positive, six-decimal, safe-base-unit schema. The coin string is derived after validation; omitting `tenant` binds the SDK recipient to the signer. Account setup uses the same SDK operation with its fixed self-funding amount and abort signal.
- **`update_app` / `restart_app`** — SDK 0.23 lifecycle primitives from `@manifest-network/manifest-sdk/deploy`, always with `pollOptions: false`, `providerUrl`, and `signal`; no chain transaction. `fredCompatibilityForProvider` explicitly selects `pr240` for dev and keeps the SDK default `v0.13` elsewhere. The selected dialect flows through capability contexts and final manifest validation. PR240 calls use `maintenanceExecution.ts`: one UUIDv4 and exact payload per logical command, independent per lease in a batch. SDK fresh-authentication and recovery support owns credential renewal; retries preserve command identity. Metadata survives reload without persisting manifest secrets, so recovering an update after reload requires its exact original bytes.
  `RESTART_INDETERMINATE`, `UPDATE_INDETERMINATE`, `MAINTENANCE_REQUEST_FAILED`, lost responses, and inconclusive verification retain pending commands unless a known durable refusal proves settlement. Timeouts never prove that nothing happened. An unrelated 409 conflict is not an observation of workload health or authority to issue a replacement. Verify the command against fresh release history, separately from readiness: PR240 Fred can restore a healthy runtime while retaining the failed restart/update diagnostics. A healthy app can therefore coexist with a failed maintenance result. Status and releases reconcile acknowledged operations without raw update bytes; unacknowledged commands still require same-key recovery because release history has no command identity. Authoritative absent/terminal chain observations retire pending metadata. Completion caches retain only payload hashes and public results. Legacy v0.13 has no command deduplication; uncertain outcomes require observation before another command, and its existing readiness/provision gates remain separate from PR240 recovery.
- **`set_custom_domain`** — `setItemCustomDomain` from `@manifest-network/manifest-sdk/deploy` (standalone tool only; the deploy path attaches domains atomically *inside* `deployManifest`).

PR240 recovery plans explicitly require the pending record to still exist;
another tab's settlement cannot become a new command with a fresh baseline.
Persisted metadata is authoritative over stale memory. After reload,
`maintenancePayload.ts` can recover exact bytes from release history or a
deterministic re-merge of a reattached file, but every candidate must match the
saved payload hash. A mismatched attachment falls through to retained memory and release history,
so the current turn can recover without first discarding its attachment. The recovery card and result
explicitly say that this attachment was not used. A failed history read or rejected signature offers another same-key recovery
attempt; only a successful history read with no matching bytes offers the stop-only exit.
Payload recovery does not establish admission or outcome.
Unacknowledged commands add no signatures or provider reads to status queries.
`reconcileProvisionStatus` preserves confirmed and failed verdicts during in-flight
observations. The shared provision patch also sets `readinessStale`, keeping failed apps eligible
for bounded background checks when Fred starts recovering them. Pinned Fred validation receipts (including durable HTTP 400s)
surface their diagnostic and settle; its pre-admission parser/header errors
remain uncertain. Cleanup after confirmed lease closure is best-effort.
Completion hashes/results are cleared for a wallet/chain when chat history or
authorization is invalidated; ordinary query-cache clears retain replay protection.
One compact nonsecret settled receipt per lease replaces the pending record at the same storage
key, so settlement reduces quota usage. Only receipts marked when recovery guidance was issued
block ordinary planning; directly reported outcomes allow routine follow-up commands. Older pending
records without an advice flag conservatively retain the recovery barrier. Nonsecret recovery
intent in sessionStorage (with an in-memory fallback) keeps this tab's old advice guarded even
after another tab completes a deliberate successor. Only the tool result that issues advice retains its
nonsecret scoped identity; older and unrelated rows never inherit it. Planning-only settled/missing-record
refusals and batch skips do not emit fresh advice identities or arm a receipt-only tab guard. Loading that row restores the guard
in another tab or after a failed sessionStorage write. Dispatch must match the active tab's bound intent;
it acknowledges that tab's earlier observed advice too, and durably retains the newest 128 consumed keys per lease in that tab so reload cannot rearm them.
On quota exhaustion, consumption may remove the matching readable entry and retain acknowledgment
in memory if the smaller replacement still cannot be written; ordinary work remains available in that
tab, while a reload can conservatively restore an original source row. Unreadable or newer evidence
is never removed. Older restored advice whose suppression has aged out conservatively needs deliberate new intent. Persistence does not scan active
intents on streaming frames. Shared advice marking updates pending
records only, never grows a settled receipt, and cannot fail a status read on quota exhaustion. A new
command requires a settled receipt when tab-local recovery intent survives a missing pending record;
without either record, even `new_command: true` remains observation-only because no outcome is known. Every new
confirmation binds the previous sent receipt's key; a changed sent receipt refuses dispatch. A never-sent
cancellation restores that receipt (or none) with bounded exact zero-HTTP proofs, preserving prior
blocking semantics without invalidating approved cards. Proofs survive successors and retire only
matching advice. The oldest proofs age out conservatively at 128 per lease; lost proof can require
deliberate new intent but cannot authorize replay.
Temporary advice for a newer unsent command cannot replace an older active guard. If older advice
arrives late, retiring the unsent command promotes that actionable identity, including after reload. Transcript
restoration reads never-sent proof first, then retains the oldest actionable advice per lease.
Verified outcomes and manifest updates survive failed
receipt writes, which cached exact retries reattempt without another provider request. If command
identity cannot be read, preserve the provider verdict but defer registry projection and completed
memoization until storage access returns. The 128-entry
session limit includes reserved work: planning checks capacity and whole batches
reserve before any request, while pending recovery remains possible at the limit. Authoritative lease closure frees pending
reservations even when storage cleanup fails.
Durable refusals settle their matching marker even after abort, but invalidated
sessions cannot receive cached results or progress. Command-owned manifests are
projected independently of unrelated registry observations. A readiness-flag refresh does not suppress
a verified provision-state verdict; the two fields have independent freshness checks. Execution, reconciliation, foreground status and background hydration share the same provision patch.
They preserve prior confirmed/failed verdicts and set `readinessStale` when runtime status carries
no verdict, even if the command itself settled. A failed fresh runtime read can use the readiness wait's
settled verdict. Cached replays identify the previous result and send no new request; interruption of local
cleanup cannot turn that verified result into uncertainty. Uncertain maintenance sets
`connectionStale` and `readinessStale` while preserving a previous provider verdict. Explicit progress
records `unconfirmed` when there is no prior verdict; missing or unmodelled status adds no provision observation. `provisionObservationPatch` shares readiness retirement between status queries, maintenance
and background reads. Fresh connections restore DNS evidence even while status is unavailable or
in progress; bounded readiness reads continue independently until a verdict or budget exhaustion.
Unset and false freshness flags are equivalent when checking observation snapshots. An explicit
command failure without a runtime reading also schedules readiness checks. Model and AppCard
Stop confirmations share a metadata-only warning naming affected apps: Fred may still execute
pending maintenance until their leases close.

Automatic deployment diagnostics retain bounded service tails with headers. An ordinary batch row
prioritizes its verdict, fail count and curated next step, then includes the services that fit and an
explicit omitted-service count. A linear reverse scan prevents trailing whitespace/control noise from
hiding the last visible line. Batch summaries redistribute
unused diagnostic space; when shortening is still required, structured diagnostics are rendered
again with the failure reason, `get_logs` lookup and service tails. They are never duplicated in the
persisted tool result. Cancelled replay details remain in the summary after progress rows disappear.
Manifest-validation lists are sanitized and capped at 4,096 code points on both compatibility paths;
other preparation failures keep their smaller cap.

⚠️ **The SDK primitives serialize their own broadcasts — call them directly, never through a signing mutex.** `deployManifest` / `stopApp` / `fundCredits` / `waitForLeaseStatus` / `updateApp` / `restartApp` mint their own ADR-036 tokens through the same non-reentrant signing mutex, so wrapping any of them in a caller-side sign-lock deadlocks (e.g. deployManifest → `providerAuth.leaseDataToken` → same mutex → circular wait). Chain-TX serialization comes entirely from `CosmosClientManager.withBroadcastLock` (held internally by the SDK cosmos-tx path) plus the mutex-wrapped `signArbitrary` (the D2 replay guard). ENG-312 Phase 8 **removed** the old `SigningContext.withSign` escape hatch — there is no caller-side sign-lock to misuse anymore.

### Wallet Integration

- cosmos-kit provides wallet abstraction (Web3Auth is the only enabled wallet provider in `src/main.tsx`; Leap, Cosmostation, Ledger packages are installed but not imported)
- `CosmosClientManager` from `@manifest-network/manifest-sdk` wraps the signer for MCP operations
- `signArbitrary` (wrapped in a signing mutex) backs the single `createProviderAuth` ADR-036 minter built once at the `useManifestMCP` root. `SigningContext` exposes it as `providerAuth` (address-param, consumed by `deployManifest`'s `FredAuthCtx`) plus `authTokens`, a thin address-binding adapter over the SAME instance (`authTokensAdapter.ts`), and `relayAuth.signChallenge` for the paid Morpheus relay's server-issued challenge — one signing mutex and one provider `AuthTimestampTracker`, never a second provider minter (D2 same-lease/same-second replay guard). ADR-036 tokens authenticate payload uploads, provider connection/status queries, and the SDK's `waitForLeaseStatus` lease-status WebSocket (via the browser `EventTransport`)

### API Layer (`src/api/`)

| Module | Purpose |
|--------|---------|
| `billing.ts` | Leases, credit accounts (custom Manifest module) |
| `sku.ts` | Provider catalog, SKU definitions |
| `skuTiers.ts` | `resolveSkuTiers(specs)` joins the chain SKU catalog with the env spec map and normalizes `basePrice` + `Unit` (PER_HOUR / PER_DAY) into `pricePerHour` display units. `hourlyPriceFromSku(sku)` is the unit→hourly converter. `getCheapestTier(tiers)` returns the lowest-`pricePerHour` entry (ties resolved by first occurrence) and is what `deploy_app` / `batch_deploy` use as the size default when the caller omits it. Returns `ResolvedSkuTier[]` ordered by env spec insertion order — that order drives the AI tool's `size.enum` and the `/help` table; the default tier is price-driven, not order-driven. Chain SKUs missing a spec entry — and spec entries missing a chain SKU — are dropped with a `logError` warning and omitted from the resolved list (config-drift policy). |
| `bank.ts` | Cosmos SDK bank queries |
| `tx.ts` | Shared tx-domain types (`LeaseItemInput`) + `Unit` re-export. ENG-312 Phase 7 deleted the hand-rolled `SigningStargateClient` + `fundCredit` — credit funding goes through the SDK's `fundCredits(TxCtx)` |
| `provider-api.ts` | Health checks and connection info — delegates to `@manifest-network/manifest-sdk/deploy` with the CORS proxy/SSRF adapter and DEV `allowLoopback` flag. `getProviderHealth` returns null on transport failure or invalid JSON but preserves SDK `invalid_response` errors for catalog diagnostics |
| `fred.ts` | Five thin Fred HTTP-function wrappers (delegate to the SDK deploy facade with `providerFetch` + `allowLoopback` injected). The WS/polling machinery moved to the SDK's `waitForLeaseStatus` + `eventTransport.ts` (ENG-312 Phase 6) |
| `eventTransport.ts` | Browser `EventTransport` for the SDK's `waitForLeaseStatus` live-status path — dev `/proxy-provider` URL reshaping, prod SSRF-validated direct connect, native `WebSocket`→`EventSocket` adapter |
| `providerFetchAdapter.ts` | `fetchFn` adapter that injects DEV CORS proxy routing and PROD SSRF validation for the SDK deploy facade's HTTP functions |
| `morpheus.ts` | OpenAI-compatible SSE streaming client via `/api/morpheus/` proxy |
| `morpheusSession.ts` | Deduplicated ADR-036 relay challenge/session client; validates wallet/chain binding, caches server-relative expiry, and starts inference timeouts only after authentication |
| `config.ts` | API endpoints, denom metadata, price formatting |
| `faucet.ts` | Faucet HTTP client — token requests, drip-and-verify with balance polling |
| `utils.ts` | Retry logic (`withRetry`) with exponential backoff |
| `readClient.ts` | Cached query-only Manifest read client (`getReadClient` / `disposeReadClient`) built from `@manifest-network/manifest-sdk`'s `createManifestReadClient`; backs all chain reads (`billing.ts`/`sku.ts`/`bank.ts` wrappers, `app_status`/`list_apps`/`browse_catalog`/`lease_history`, composite `get_balance`) |
| `index.ts` | Barrel re-exports for API modules |

### AI Store (`src/stores/aiStore.ts`)

All AI chat state lives in a single Zustand store. Actions that are large async functions are extracted into `src/stores/aiActions/*.ts` as plain functions receiving `get`/`set`.

| Module | Purpose |
|--------|---------|
| `aiStore.ts` | Store definition, type, simple actions, tool cache, lifecycle |
| `aiActions/sendMessage.ts` | `sendMessage` streaming loop |
| `aiActions/confirmAction.ts` | `confirmAction` + `cancelAction` |
| `aiActions/batchDeploy.ts` | `requestBatchDeploy` |
| `aiActions/toolExecution.ts` | `processToolCalls`, `handleToolCall` |
| `aiActions/streaming.ts` | `scheduleStreamingUpdate`, `flushPendingUpdate` (RAF) |
| `aiActions/persistence.ts` | Browser-global settings plus versioned, wallet-and-network-scoped chat history loading/saving and persistence subscriptions |
| `aiActions/skuTiers.ts` | `loadSkuTiers` / `retrySkuTiers` — boot-time SKU resolution. Parses `PUBLIC_SKU_SPECS`, calls `resolveSkuTiers()`, writes the `SkuTiersState` slice (`phase: 'idle' \| 'loading' \| 'ready' \| 'error'`, `tiers`, `denomSymbol`, `error`). Concurrent calls dedupe via the store's `_skuTiersInFlight` promise field. `retrySkuTiers` is a no-op from `ready` (consumers read `skuTiers.tiers` without phase-guarding, so transitioning `ready → loading` would leak stale tiers to in-flight chat/tool execution); from `idle`/`loading`/`error` it resets phase and re-issues the fetch. Used by the Retry button on `ChatPanel`'s tier-error banner. |
| `aiActions/stopApp.ts` | `requestStopApp` (synthesizes a `stop_app` pendingConfirmation from a UI surface) |
| `aiActions/utils.ts` | `generateMessageId`, `trimMessages`, `createAssistantMessage`, `toChatApiMessages`, `getAppRegistryAccess` |

`AIProvider` (`src/contexts/AIContext.tsx`) is a thin lifecycle wrapper that sets up persistence subscriptions, health checks, confirmation timeouts, fires `loadSkuTiers()` once on mount, and on unmount calls `store.getState().destroy()` and `disposeReadClient()` (`src/api/readClient.ts`).

**`skuTiers` slice on the store** (`aiStore.ts`): the resolved SKU tier list lives here as `SkuTiersState`. Deploy surfaces are **never disabled** by tier state — example-app buttons, sidebar re-deploy, and `ConfirmationCard` Confirm always render enabled. The executor and `ConfirmationCard` share `resolveSizeOrCheapest` (`src/api/skuTiers.ts`) so an omitted/unavailable size deploys on the cheapest tier; the card shows the resolved tier's price + specs (`formatTierSpecs`) and names any substitution (a `'cheapest-unavailable'` fallback). An empty tier list yields the executor's inline `Tier catalog unavailable` error (with a `Retry` → `retrySkuTiers`) — the single failure mode. Ordinary single-deploy planning reads the resolved list from `ToolExecutorOptions.tiers`; `confirmAction` + `batchDeploy` + `toolExecution` thread `get().skuTiers.tiers` into each call. Batch deploy uses those tiers as its resource-spec map but resolves both the initial consent plan and the confirm-time integrity plan against the active chain catalog, preventing a session-cached price/provider from creating a permanently unconfirmable plan.

### Hooks (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useManifestMCP` | Bridges cosmos-kit with `@manifest-network/manifest-sdk` (builds the `CosmosClientManager` + `SigningContext` = `{ providerAuth, authTokens, relayAuth }`) |
| `useAutoScroll` | MutationObserver-based auto-scroll that respects user scroll position |
| `useInputHistory` | Arrow-key navigation through past chat inputs |
| `useAI` | Zustand store consumer — selects all public state/actions via `useShallow` |
| `useToast` | Context consumer hook for ToastContext |
| `useCopyToClipboard` | Clipboard copy with feedback state |
| `useAccountSetup` | One-shot sequential account setup pipeline — requests PWR from the faucet (PWR pays both gas and credits after ENG-243) and funds credits on first connect. Returns `AccountSetupState` (`isInitialSetup` + `phase`) for the `AccountSetupOverlay`. Setup data persisted to localStorage via `versionedStorage`. MFX is no longer part of the blocking flow; users who need MFX can request it via the `request_faucet` chat tool |
| `useDnsStatusPolling` | Single polling driver for custom-domain DNS state. Mounted in `MainLayout` (outside the sidebar's `ErrorBoundary`, so a sidebar render error doesn't take DNS state down with it). Iterates running apps with `customDomains` and writes per-domain `DnsStatusEntry` rows into `aiStore.dnsStatuses`. All custom-domain surfaces (sidebar dot, single-domain card, multi-domain card, AppCard's deploy-success row) read from this slice — no per-component poll loops |
| `useRegistryReconciliation` | Recurring chain-to-registry repair driver, mounted in `MainLayout` outside the sidebar boundary. Refreshes live lease state and custom domains from complete active/pending tenant-list payloads, then resolves missing catalog metadata. The aggregate deadline is twice the API timeout for the current two sequential stages, including inter-stage processing; changes to the stages must revisit that bound. While visible, the next poll is scheduled from pass completion with a 15s base delay and 30s/60s/120s backoff on consecutive failures, including aggregate timeouts. Hiding pauses scheduled ticks without cancelling active work. Becoming visible resets backoff and refreshes immediately if no pass is in flight; otherwise the current pass finishes and schedules from its result. Pre-RPC baselines prevent stale lease/domain observations from overwriting transaction results. Provider recovery runs separately |
| `useAppRecovery` | Single background provider-recovery driver in `MainLayout`, outside the sidebar boundary. Fairly selects one eligible app per idle tick, applies per-app backoff and retirement, and cancels on foreground activity or wallet changes. Cancelled work yields its place to peers without spending its attempt budget. `hydrateDiscoveredApp` accepts exactly one app, so the driver owns all scheduling |
| `useRegistryApps` | `useSyncExternalStore` view of the wallet's app registry, kept live via `subscribeToRegistry`. Used by `MainLayout` to feed the DNS polling driver |
| `useVisibilityPolling` | Visibility-aware polling with optional exponential backoff and a `restartKey` for context changes such as wallet switches. Pauses scheduled ticks while hidden, resumes when visible, and serializes each lifecycle's ticks. Used by `AIProvider` (health check), `useRegistryReconciliation`, `useDnsStatusPolling`, and `AppsSidebar`; the sidebar bounds both billing reads, backs off failures, scopes rendered registry/credit snapshots plus async writes to the current wallet lifecycle, reference-counts active credit passes per lifecycle and releases unclaimed retry reservations when their owner lifecycle ends, keeps inline Retry disabled with origin-neutral `Refreshing…` copy and only the failure copy assertive, and restores keyboard focus after a failed pass only when disabling Retry left focus on the document body |

> Note: `useConfirmationFlow.test.tsx`, `useMessageManager.test.ts`, and `useToolCache.test.ts` are pure-logic test files for behaviour now living in `src/stores/aiActions/` and `src/stores/aiStore.ts`. They retain the original hook names because the underlying contracts haven't changed; no source hook file exists.

### Utility Modules (`src/utils/`)

| Module | Purpose |
|--------|---------|
| `errors.ts` | `logError()` — structured error logging (use instead of raw `console.error`) |
| `hash.ts` | `sha256()`, `sha256Hex()`, `toHex()`, `toBytes()`, `generatePassword()`, `validatePayloadSize()`, `getPayloadSize()`, `isValidMetaHash()`; `MAX_PAYLOAD_SIZE` (5KB) |
| `json.ts` | `bigIntReplacer` — `JSON.stringify` replacer that converts `bigint` values to strings to avoid serialization errors |
| `format.ts` | Amount conversion (`toBaseUnits`, `fromBaseUnits`), date/duration formatting, UUID validation |
| `fileValidation.ts` | Upload validation: size limits, allowed extensions (`.json`, `.txt` — YAML dropped; the deploy path is JSON-only since `deployManifest` JSON-parses the manifest, so `.txt` content must parse as JSON too), MIME type checks, JSON-only manifest content validation (`validateManifestContent`) |
| `pricing.ts` | BigInt-based cost calculations (`formatCostPerHour`, `calculateEstimatedCost`) to avoid integer overflow |
| `leaseState.ts` | Lease state display helpers — badge classes, labels, colors, filter mapping |
| `address.ts` | Bech32 address validation (`isValidBech32Address`) and truncation (`truncateAddress`) |
| `url.ts` | URL validation with SSRF protection (`parseHttpUrl`, `isUrlSsrfSafe`) |
| `connection.ts` | FQDN validation/normalization, instance URL collection, CNAME-target resolution; `nonEmptyPorts` shared by deploy URL shaping and AppCard; `formatPortEndpoint` substitutes the reported Docker host for wildcard binds and brackets IPv6 addresses |
| `tx.ts` | Transaction event parsing utilities (extract attribute values from TX events) |
| `versionedStorage.ts` | Versioned localStorage with schema migrations (envelope format, upgrade chain) |
| `customDomainStatus.ts` | Custom-domain status computation (`computeStatus` → `CustomDomainStatusReport`; `CustomDomainStatusKind`, DNS/HTTPS probe result types) |
| `customDomainValidation.ts` | Custom-domain FQDN validation (`validateCustomDomainFormat`, `isApex`, `isReservedSuffix`, `apexRecordKindLabel`, `APEX_WARNING`) |
| `cn.ts` | Re-exports `clsx` as `cn`: `cn('foo', condition && 'bar')` |

### Constants (`src/config/constants.ts`)

All tunable timeouts, cache sizes, and limits are centralized here. Key values:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_TRANSACTION_GAS` | 50,000,000 | SDK-enforced gas ceiling; combined with `GAS_PRICE` to show the maximum network fee before approval |
| `AI_STREAM_TIMEOUT_MS` | 30s | Per-chunk stream timeout (runtime-configurable) |
| `AI_CONFIRMATION_TIMEOUT_MS` | 5min | Auto-cancel pending TX confirmations (runtime-configurable) |
| `AI_DEPLOY_PROVISION_TIMEOUT_MS` | 10min | Max polling time for deploy readiness — sized to fred's own `ProvisionTimeout` (runtime-configurable; `NUMERIC_LIMITS` caps operator overrides at 15min, the `AI_LEASE_WAIT_TIMEOUT_MS` envelope, so the knob raises as well as lowers) |
| `AI_LEASE_WAIT_TIMEOUT_MS` | 15min | Deadline for the restart/update `waitForLeaseStatus` — fred's `ReconcileInterval` + `ProvisionTimeout`, so an ACTIVE-but-`retained` lease being re-provisioned isn't marked failed |
| `AI_MESSAGE_DEBOUNCE_MS` | 300ms | Debounce rapid message sends |
| `AI_MAX_TOOL_ITERATIONS` | 10 | Max tool calls per message (prevents loops) (runtime-configurable) |
| `AI_MAX_MESSAGES` | 200 | Chat history memory limit (runtime-configurable) |
| `AI_TOOL_CACHE_TTL_MS` | 10s | Query result cache lifetime |
| `AI_TOOL_CACHE_MAX_SIZE` | 50 | Max cached query results |
| `AI_MAX_RETRIES` | 3 | Max retry attempts for transient network errors (runtime-configurable) |
| `AI_RETRY_BASE_DELAY_MS` | 1s | Base delay for exponential backoff |
| `AI_TOOL_API_TIMEOUT_MS` | 15s | Timeout for blockchain API calls during tool execution (runtime-configurable) |
| `AI_HEALTH_CHECK_INTERVAL_MS` | 60s | Base interval for Morpheus connectivity checks |
| `AI_HEALTH_CHECK_MAX_BACKOFF` | 8 | Max backoff multiplier (×60s = 8min ceiling) when health checks repeatedly fail |
| `AI_BATCH_DEPLOY_CONCURRENCY` | 4 | Max concurrent batch deploys (runtime-configurable) |
| `AI_DEPLOY_LOG_PREVIEW_CHARS` | 2000 | Automatic container-log tail; batch rows remain bounded and direct users to `get_logs` |
| `AI_HISTORY_ERROR_CHARS` | 10,240 | Persisted chat-error limit in UTF-16 code units, including a truncation ellipsis |
| `AI_MAINTENANCE_PREPARATION_DETAIL_CHARS` | 1024 | Sanitized wallet/storage/SDK preparation diagnostics |
| `AI_MANIFEST_VALIDATION_DETAIL_CHARS` | 4096 | Sanitized manifest-validation diagnostics in planning and confirmation |
| `MAINTENANCE_NEVER_SENT_PROOF_LIMIT` | 128 | Exact zero-HTTP proofs retained per lease across cancellations and settlements |
| `MAINTENANCE_CONSUMED_ADVICE_LIMIT` | 128 | Consumed advice keys retained per lease in this tab; older restored advice fails conservatively |
| `MAX_PAYLOAD_SIZE` | 5KB | Maximum file upload size (in `hash.ts`) |
| `FRED_POLL_INTERVAL_MS` | 3s | Default polling interval for Fred status checks (passed as `waitForLeaseStatus`'s `intervalMs`) |
| `DNS_POLL_INTERVAL_MS` | 30s | Polling interval for browser-side DNS / HTTPS probes (`useDnsStatusPolling`) |
| `DNS_STUCK_THRESHOLD_MS` | 5min | Show "verify with dig locally" hint after sustained `pending_dns` (only when slice has no `detail`) |
| `AUTO_REFRESH_INTERVAL_MS` | 15s | Auto-refresh interval for sidebar data polling |
| `APP_RECOVERY_POLL_INTERVAL_MS` | 1s | Idle checks for the next eligible app |
| `APP_RECOVERY_MAX_ATTEMPTS` | 4 | Initial automatic attempts per unchanged app snapshot |
| `APP_CONNECTION_RECOVERY_MAX_ATTEMPTS` | 8 | Total attempts for uncertain readiness after maintenance or an arrived Fred response, or confirmed apps with invalidated connection inventory |
| `APP_CONNECTION_RECOVERY_INTERVAL_MS` | 300000 | Delay between additional recovery attempts after the initial four |
| `APP_RECOVERY_TIMEOUT_MS` | `AI_TOOL_API_TIMEOUT_MS` | Aggregate provider-recovery deadline |
| `REGISTRY_RECONCILIATION_TIMEOUT_MS` | `2 * AI_TOOL_API_TIMEOUT_MS` | Aggregate deadline for sequential lease and catalog reads |
| `HEALTH_CHECK_TIMEOUT_MS` | 5s | Timeout for individual health-check requests |
| `POST_TX_REFETCH_DELAY_MS` | 1s | Delay before refetching state after a transaction |
| `COPY_FEEDBACK_DURATION_MS` | 2s | "Copied" feedback display duration |
| `DEFAULT_PAGE_SIZE` | 10 | Default page size for paginated lists |
| `TX_HASH_DISPLAY_LENGTH` | 16 | Truncated tx-hash display length |
| `MAX_REASON_LENGTH` | 256 | Max length for reason/description fields |
| `MAX_FILENAME_LENGTH` | 255 | Max filename length for uploads |
| `ACCOUNT_SETUP_PWR_THRESHOLD` | 5 | PWR balance below which faucet is requested (display units) |
| `ACCOUNT_SETUP_CREDIT_THRESHOLD` | 5 | Credit balance below which credits are funded (display units) |
| `ACCOUNT_SETUP_CREDIT_AMOUNT` | 5 | PWR amount funded into credits per setup pass (display units); kept below the faucet drip so PWR remains for gas (ENG-565) |
| `ACCOUNT_SETUP_GAS_RESERVE` | 1 | PWR headroom reserved for gas — funding guard requires balance ≥ credit + this reserve so fund-credit never overdraws (post ENG-243 PWR gas) |
| `ACCOUNT_SETUP_POLL_INTERVAL_MS` | 2s | Poll cadence for balance verification after faucet drip |
| `ACCOUNT_SETUP_POLL_TIMEOUT_MS` | 10s | Timeout for balance verification poll loop |
| `ACCOUNT_SETUP_COMPLETE_DELAY_MS` | 1.5s | Delay before dismissing account setup overlay after completion |
| `ACCOUNT_SETUP_RETRY_DELAY_MS` | 5s | Delay before retrying a failed setup step |
| `ACCOUNT_SETUP_ERROR_DELAY_MS` | 5s | Delay before dismissing the overlay when an error persists |
| `MANIFEST_NOTICE_KEY` | `'_notice'` | Key used to carry a display-only notice through manifest JSON; stripped before upload |

## Styling

- Tailwind v4 with inline `@theme` configuration in `src/index.css` (no separate `tailwind.config` file)
- Custom Manifest design system using OKLCH color space
- Fonts: Plus Jakarta Sans (headings/body), IBM Plex Mono (code)
- Use `cn()` from `src/utils/cn.ts` (re-export of `clsx`) for conditional class names
- No CSS modules or styled-components — pure Tailwind utility classes

## Key Patterns

- **Zustand store**: AI state uses a Zustand store (`src/stores/aiStore.ts`) instead of React Context + refs. Async callbacks read current state via `get()` — no ref mirrors needed. Actions are plain functions receiving `get`/`set`, extracted into `src/stores/aiActions/`. The `useAI()` hook selects all public fields via `useShallow` for backward compatibility.
- **SSRF protection**: `src/utils/url.ts` provides `parseHttpUrl` and `isUrlSsrfSafe` (DEV mode allows localhost via `isUrlSsrfSafe`); `src/ai/validation.ts` adds `isPrivateHost()` with `ipaddr.js` for IP range classification
- **Error utilities**: Use `logError()` from `src/utils/errors.ts` instead of raw `console.error`
- **Retry logic**: Use `withRetry()` from `src/api/utils.ts` for transient network error recovery with exponential backoff
- **Tool result caching**: Query tool results cached for 10s in the AI store to reduce redundant API calls (max 50 entries; when full, the 10% oldest by insert timestamp — minimum 1 — are evicted in one batch (10% of the current max 50 = 5)). Cache is scoped per wallet address and cleared on wallet change.
- **Chain reads**: Use `getReadClient()` (`src/api/readClient.ts`) — the cached SDK read client. Typed methods (`getLease`, `getLeasesByTenant`, `getProviders`, `getSKUs`, `getBillingParams`) return branded, numeric-enum-decoded data; the not-found-sensitive / passthrough reads (credit family, single-denom bank balance) ride `client.query.<module>.<svc>()` and classify not-found via the SDK's `isNotFoundError`. The old `queryClient.ts` + `lcdConvert()` / `fixEnumField` (which patched `fromAmino`'s string enums) are gone — the read client decodes numeric enums natively.
- **Hex encoding**: Use `toHex()` from `src/utils/hash.ts` to convert `Uint8Array` to hex strings (e.g., metaHash display). Do not inline `Array.from(...).map(b => b.toString(16)...)`.
- **Dev CORS proxy** (`providerFetchAdapter.ts`):
  - **DEV**: routes every provider HTTP request through `/proxy-provider`, sets the `X-Proxy-Target` header to the real upstream, and the rsbuild dev proxy uses that header to route the request after passing it through `isValidProxyTarget` (cloud-metadata blocks, dangerous IP ranges, embedded credentials).
  - **PROD**: skips the dev proxy entirely; runs `parseHttpUrl` + `isUrlSsrfSafe` and fetches the URL directly (no `X-Proxy-Target`, no `/proxy-provider`).
  - Every provider HTTP function from the SDK deploy facade accepts a `fetchFn` parameter; Barney always passes `providerFetch` (the singleton from `providerFetchAdapter.ts`). New functions that talk to providers must do the same or they will work in dev (CORS) but break in prod (SSRF), or vice versa.
  - **WebSockets** can't set headers, so `eventTransport.ts`'s `browserEventTransport` switches on `import.meta.env.DEV`: in dev it reshapes the SDK-supplied `wss://…` URL to `wss?://<host>/proxy-provider/...?token=…&target=<upstream>`; in prod it connects directly (SSRF-validated). The rsbuild proxy router accepts the `target` query string when `X-Proxy-Target` is absent.
- **Stream timeout**: `processStreamWithTimeout` in `src/ai/streamUtils.ts` wraps the AI stream async generator with per-chunk timeout protection (`AI_STREAM_TIMEOUT_MS`, default 30s). Prevents hung connections from blocking the UI indefinitely. The inner `withTimeout` generator ensures cleanup of the underlying generator via `finally` block.
- **Tool-call leak stripping**: `stripToolCallLeaks()` in `src/ai/streamUtils.ts` filters raw `[TOOL_CALLS]` markers that some models emit as literal text instead of structured tool_calls. Legacy safeguard from the Ollama/Mistral era, kept as defensive code for the Morpheus API.
- **Message debouncing**: The AI store debounces rapid message sends via `AI_MESSAGE_DEBOUNCE_MS` (300ms) and aborts in-flight streams when a new message is sent.
- **Chat persistence**: The AI store persists browser-global settings under `barney-ai-settings` and each wallet/network transcript under `barney-ai-history:v1:{chainId}:{normalizedAddress}` via Zustand subscriptions. The selected identity is also cached in memory so A → B → A does not re-read storage or lose unsaved session state. History is validated and sanitized on first load; corrupted or identity-mismatched data is cleared, but future-version envelopes are preserved. Streaming messages are excluded. Error alerts preserve authored line breaks and up to `AI_HISTORY_ERROR_CHARS` (10,240 UTF-16 code units) on both save and load. Larger strings are truncated with an ellipsis without splitting a surrogate pair; they are not discarded merely for exceeding the old 2,048-character limit. Non-string errors are omitted. Disabling **Save Chat History** stops future writes without deleting saved transcripts, and re-enabling it snapshots the selected wallet only when that transcript is non-empty. The two deletion paths are both explicit and both scoped to the active wallet/network: the `/clear` command and the confirmed **Clear This Wallet's History** button. Both are also cancellation boundaries — they drop any open confirmation, staged payload and deploy progress, and bump `authorizationEpoch` so late async work cannot repopulate a transcript the user deleted — so both gate on `isStreaming`. That gate is load-bearing: during a confirmed transaction the store's `abortController` **is** that transaction's, and aborting it mid-provision strands a paid lease the provider never received a manifest for, with the release guidance landing in the transcript just deleted. `clearHistory` additionally refuses to clear while `activeTransactionMessageId` is set, so a direct store call cannot detach the still-running transaction either. A future-version envelope is never overwritten or removed by an automatic write; that is re-checked on every save, so a sibling tab on a newer build cannot be clobbered.
- **Confirmation timeout**: Pending transaction confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes) to prevent stuck UI state.
- **UI-direct store actions**: Actions that synthesize a `pendingConfirmation` from a UI surface (e.g. `requestStopApp`, `requestBatchDeploy` in `src/stores/aiActions/`) MUST gate on `pendingConfirmation !== null` before constructing the new action. Without the gate, a click while another confirmation card is open silently overwrites the store's pending action and orphans the prior tool message (`awaitingConfirmation: true`, no path to confirm/cancel — chat wedged). Refused Stop actions leave the existing request or confirmation intact and add local feedback for busy, disconnected, unavailable, and already-inactive cases; those messages are not sent to the model.
- **App registry scoping**: Registry is per-wallet in localStorage. `AppShell` syncs wallet changes and clears deploy progress on disconnect.
- **Registry status is DERIVED, never written**: writers record `chainState` only from chain evidence and `provisionState` only from provider evidence; `deriveAppStatus` computes the badge. A request refusal, auth failure, transport loss, `RESTART_INDETERMINATE`, `UPDATE_INDETERMINATE`, or `MAINTENANCE_REQUEST_FAILED` does not establish workload health. Do not mark healthy apps failed from POST exceptions or treat an uncertain command as safe to replace. A separately observed healthy runtime stays confirmed even when correlated release diagnostics establish the restart/update failed and compensated. `stop_app` records only `chainState: absent`, preserving prior workload diagnostics.
- **Abort guards key on the ERROR, not on the signal**: use `isAbortError(err)` instead of an ambient `signal.aborted` check. Any new chat message can abort the controller while an unrelated failure arrives. Pre-dispatch cancellation is safe only when the SDK establishes the request was never sent and no older unresolved attempt exists. Cancellation while recovering an already-sent command or waiting for readiness does not mean the provider did nothing; retain the operation key and exact payload until a correlated settled verdict is verified.
- **An unmodelled provider verdict defaults to being trusted**: fred's `ProvisionStatus` and `Reason` sets are open and add-only, so gates over them are written as NEGATIVE lists — name the values that carry no verdict (`isUnsettledProvisionStatus`, `provisionStatus.ts`) or that the operation can be blamed for (`UPDATE_ATTRIBUTABLE_REASONS`) and let everything else fall to the conservative arm. A positive allowlist makes every value fred adds later silently report success. Same open-set discipline as `browse_catalog`'s health verdict.
- **Error UX boundary**: **Toasts** (`useToast` + `ToastContainer`) are reserved for surfaces that exist *before* the chat panel mounts — wallet connection errors (popup blocked / closed / network) in `AppShell`. User-initiated chat and tool errors flow through **chat messages** (`error` field on `ChatMessage`, surfaced as inline alerts with `ERROR_PATTERNS` regex-matched "Try again" suggestion buttons in `MessageBubble.tsx`): tool failures, deploy failures, signing rejections, payload validation, and manifest parse errors all land in chat. Background reads that belong to a persistent non-chat surface stay local to that surface; the sidebar credit poll, for example, renders an inline alert with Retry rather than injecting chat noise. Caught exception text in balance, log, diagnostic and release queries, and executor catch-alls, is sanitized and capped at `FAILURE_DETAIL_CHARS` (256 retained code points plus an ellipsis). Authored multi-line batch summaries and successful log output retain their layout. Don't add new toasts post-connect.
- **Custom-domain DNS state**: All four custom-domain surfaces (sidebar dot, deploy success pill, single-domain card, multi-domain consolidated card) read DNS status from a single source — `aiStore.dnsStatuses`. The map is populated by `useDnsStatusPolling`, mounted exactly once in `MainLayout` (deliberately outside the sidebar's `ErrorBoundary` — a sidebar render error must not take DNS state down with it). Lifecycle operations mark saved connection inventory `connectionStale` until a fresh connection read clears it. Stale inventory cannot supply an expected CNAME target; a changed or invalidated target resets cached DNS verdicts, including terminal ones. Background recovery also retries confirmed apps with saved, invalidated connections: each attempt checks readiness and connection data with separate credentials. Uncertain readiness after maintenance or an arrived, unsettled status response also keeps the extended allowance after a fresh connection read or reload. Ordinary failed status fetches or authentication do not create readiness staleness; pending-maintenance reconciliation can still set it when its provision observation fails; readiness-only changes do not notify UI subscribers or cancel DNS probes. After the initial four attempts, four more run at five-minute intervals; other missing inventory stays within the initial budget unless pending maintenance still needs a readiness verdict. Failure verdicts retire recovery, and exhausted budgets require an explicit status check or a changed app snapshot. DNS/HTTPS probes wait until the expected target is available. No surface runs its own polling loop. Adding a new surface means reading `dnsStatuses.get(dnsStatusKey(leaseUuid, fqdn))`, not adding another `useVisibilityPolling`.
- **SKU tier resolution**: Single source of truth for ordinary planning and display is `aiStore.skuTiers` (slice produced by `loadSkuTiers`, kicked off once in `AIProvider`). The resolved tier list is chain ∩ `PUBLIC_SKU_SPECS` — chain owns SKU names + per-`Unit` prices (normalized to `$/hr` in `hourlyPriceFromSku()`), env owns CPU/RAM/disk. The UI cache is session-lifetime with no periodic refresh; batch deploy resolves both its initial plan and confirm-time integrity plan against active chain SKUs so the consent hashes use the same price/provider source. All deploy-related surfaces read from the slice: `deploy_app.size.enum` (`buildAITools(tiers)`), `/help` table (`buildHelpText(skuTiers)`), system prompt tier block (`getSystemPrompt(addr, tiers)`), `ConfirmationCard` price/specs row, executor (`compositeTransactions.ts` reads `options.tiers`). No gating: deploy surfaces (`ChatPanel` example-app buttons, `AppsSidebar` re-deploy, `ConfirmationCard` Confirm) are never disabled by tier state. The executor + `ConfirmationCard` share `resolveSizeOrCheapest` — an omitted or unavailable size resolves to the cheapest tier, and the card discloses the resolved tier's price + specs (`formatTierSpecs`) plus a substitution note when an explicitly-requested size isn't offered (`fallback === 'cheapest-unavailable'`). An empty tier list is the only hard failure: the executor returns `Tier catalog unavailable — try again in a moment.`, surfaced inline in chat with a `Retry` (`MessageBubble` `ERROR_PATTERNS` → `retrySkuTiers`). This is also the single failure mode for `buildAITools([])` omitting the `size.enum`.

### Example Apps

`src/config/exampleApps.ts` — Pre-defined app/game manifests for one-click deploys from ChatPanel.

- `EXAMPLE_APPS` array with `group: 'games' | 'apps' | 'stacks'` classification
- `findExampleByAppName(appName)` — Reverse-lookup by registry name
- `buildExampleManifest(app)` — Produces final manifest JSON. Resolution order:
  1. `manifestFactory()` — if present, builds the complete manifest dynamically (used by stacks like WordPress/Ghost that need coordinated passwords across services)
  2. `envFactory()` — if present, merges generated env vars (e.g., `generatePassword()`) into `manifest.env` (used by single-service databases)
  3. `manifest` — static manifest object used as-is (games, simple services)
- ChatPanel uses these for deploy buttons; `AppsSidebar` uses them as re-deploy fallback

## Chain Configuration

Defined in `src/config/chain.ts`:
- Chain name: `manifestlocal` (used for cosmos-kit / chain registry lookups)
- Chain ID: configurable via `PUBLIC_CHAIN_ID` (default: `manifest-ledger-beta`)
- Gas price: configurable via `PUBLIC_GAS_PRICE` (default: `0.0025factory/manifest1afk…/upwr`)
- Denoms: `umfx` (native), `factory/.../upwr` (PWR factory token) - both 6 decimals
- Endpoints default to localhost (26657 RPC, 1317 REST)

### Runtime Environment Variables

18 client-side `PUBLIC_*` variables use a 3-tier fallback defined in `src/config/runtimeConfig.ts`:

1. `window.__RUNTIME_CONFIG__` — set by `public/config.js` (generated at container startup by `docker/env.sh`)
2. `import.meta.env` — Rsbuild static replacement from `.env` files (requires static property access, not dynamic `import.meta.env[key]`)
3. Hardcoded defaults in `DEFAULTS` map

Consumer code imports `runtimeConfig` from `src/config/runtimeConfig.ts` — never reads `import.meta.env.PUBLIC_*` directly.

Built-in flags (`import.meta.env.DEV` / `PROD`) remain build-time and are accessed directly where needed.

Client-side variables: `PUBLIC_REST_URL`, `PUBLIC_RPC_URL`, `PUBLIC_MORPHEUS_MODEL`, `PUBLIC_WEB3AUTH_CLIENT_ID`, `PUBLIC_WEB3AUTH_NETWORK`, `PUBLIC_PWR_DENOM`, `PUBLIC_GAS_PRICE`, `PUBLIC_CHAIN_ID`, `PUBLIC_FAUCET_URL`, `PUBLIC_AI_STREAM_TIMEOUT_MS`, `PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS`, `PUBLIC_AI_TOOL_API_TIMEOUT_MS`, `PUBLIC_AI_MAX_RETRIES`, `PUBLIC_AI_CONFIRMATION_TIMEOUT_MS`, `PUBLIC_AI_MAX_TOOL_ITERATIONS`, `PUBLIC_AI_MAX_MESSAGES`, `PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY`, `PUBLIC_SKU_SPECS`

`PUBLIC_SKU_SPECS` is special: it's a JSON-string env (e.g. `'{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}, ...}'`) parsed by `src/config/skuSpecs.ts`'s `parseSkuSpecs()` into a `Record<string, {cores, ramMB, diskGB}>`. The chain owns SKU names + prices; this env owns resource specs. The resolved tier list is the chain ∩ env intersection (see `src/api/skuTiers.ts`). Two distinct error diagnostics by source: empty / unparseable / all-entries-invalid `PUBLIC_SKU_SPECS` short-circuits synchronously to `error` with `"PUBLIC_SKU_SPECS is empty or invalid — no SKU specs configured."` (no chain call); a non-empty spec map with no chain SKU intersection lands in `error` after the chain fetch with `"No tiers available — check PUBLIC_SKU_SPECS and chain SKU catalog."` Both leave the slice with empty `tiers`; deploy buttons stay enabled, and a deploy attempt surfaces the executor's inline `Tier catalog unavailable` chat error with a `Retry` control (the `/help` table also shows the error). Tier order in the resolved list follows env spec **insertion order** and drives the AI tool's `size.enum`, the `/help` table, and the system-prompt tier block — but the **default** deploy size is the cheapest available tier (lowest `pricePerHour`, picked via `getCheapestTier(tiers)`), not `tiers[0]`. Insertion order is for presentation; price wins for defaults.

Server-side variables (never shipped to browser):
- `MORPHEUS_API_KEY` — read only by the authenticated Node relay and injected into its one allowlisted upstream request
- `PUBLIC_MORPHEUS_URL` — upstream Morpheus API base URL read by the relay
- `MORPHEUS_RELAY_*` — origin/session/request/concurrency/deadline policy plus required identity/provider quotas, pricing, and durable state path

### Morpheus API Relay

The client never calls the Morpheus API directly. All AI requests go through `/api/morpheus/...` (relative to origin):

- **Relay**: `server/` verifies a one-time ADR-036 wallet/chain challenge, issues an HttpOnly session, validates the sole paid route/model/body, durably reserves identity/provider quota, injects the key, and bounds concurrency/streaming. Missing usage or uncertain failures keep their reservation.
- **Production**: nginx applies coarse IP/origin/body controls and proxies `/api/morpheus/` to the same-container relay on localhost. Its generated config and child environment contain no relay secret.
- **Development**: Rsbuild proxies `/api/morpheus` to that same relay on localhost. It never reads or injects the provider key.
