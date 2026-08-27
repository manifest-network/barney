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
                  │       ├─ useDnsStatusPolling (mounted here, OUTSIDE the sidebar's ErrorBoundary)
                  │       ├─ ErrorBoundary (sidebar isolation)
                  │       │   └─ AppsSidebar (wallet, credits, running apps)
                  │       ├─ AIErrorBoundary
                  │       │   └─ ChatPanel (messages, input, settings)
                  │       │       ├─ MessageBubble (per-message rendering)
                  │       │       │   └─ StreamingText (typewriter effect with link detection)
                  │       │       ├─ ProgressCard (during deploy)
                  │       │       ├─ AppCard (deploy success — wired via MessageCard `app` variant; embeds custom-domain row)
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

`AppShell` (`src/components/layout/AppShell.tsx`) is the top-level router. It syncs wallet state (clientManager, address, and a `signing` SigningContext) from cosmos-kit into the AI store via `setSigning`.

### AI Tool Execution Flow

The AI assistant uses a 3-layer architecture:

1. **AI Store** (`src/stores/aiStore.ts`) - Zustand store managing chat state, streaming, tool execution, and wallet refs. Actions in `src/stores/aiActions/`.
2. **useManifestMCP** (`src/hooks/useManifestMCP.ts`) - Bridges cosmos-kit with `@manifest-network/manifest-sdk`
3. **Tool Executor** (`src/ai/toolExecutor/`) - Dispatches to composite executors:
   - **Entry point** (`index.ts`): Contains `QUERY_TOOLS`/`TX_TOOLS` sets and `executeTool()` dispatcher
   - **Types** (`types.ts`): `ToolResult`, `ToolExecutorOptions`, `PayloadAttachment`, etc.
   - **Query tools** (`compositeQueries.ts`): Execute immediately — `list_apps`, `app_status`, `get_logs`, `get_balance`, `browse_catalog`, `lease_history`, `app_diagnostics`, `app_releases`, `request_faucet`
   - **TX tools** (`compositeTransactions.ts`): Return `requiresConfirmation: true`, user approves via `ConfirmationCard`, then `executeConfirmedTool()` broadcasts — `deploy_app`, `stop_app`, `fund_credits`, `restart_app`, `update_app`, `set_custom_domain`. `deploy_app`/`batch_deploy` delegate the create-lease → (set-domain) → upload → provision-poll spine to the SDK's `deployManifest` primitive (ENG-279 deploy-path rewrite); barney keeps the plan phase, registry state machine, progress UI, and URL shaping around it. Deploy-path helpers live here: `buildFredAuthCtx` (assembles the `FredAuthCtx` deployManifest needs), `classifyLeaseChainState` + `handleDeployManifestError` (post-throw error handler, in `deployError.ts`). It branches on the SDK's STRUCTURED discriminants first — `details.readiness_unconfirmed` → still-deploying ("we never found out" is never "failed", and nothing suggests tearing the lease down), `details.failedStep` `'set_domain'`/`'upload'` → failed (the provider holds no manifest), `failedStep: 'poll'` without the readiness flag → failed on the provider's own verdict — and only falls back to the `getLease` chain check for a throw carrying none. The chain lease is ACTIVE for the whole provisioning window, so the chain verdict cannot tell those apart and used to report all of them as "App is live!". Each arm records the observation it has: readiness-unconfirmed → `provisionState: 'unconfirmed'`, no-manifest-uploaded / poll-verdict → `provisionState: 'failed'`, `TerminalChainStateError` → `chainState: 'absent'` **and** `provisionState: 'failed'` (the lease is gone, so the deploy definitively failed and cannot recover — recording only the chain fact derived `stopped`, which contradicted the chat copy and locked the entry out of `app_diagnostics`/`app_releases`, the two tools that could explain it), and the two unattributable chain fall-throughs keep writing a bare `status`
   - **Batch runner** (`batchRunner.ts`): Shared batch execution infrastructure — `createSigningMutex`, `runBatchWithConcurrency`, `computeOverallPhase`, `summarizeBatchResult`. Used by batch deploy and batch restart. Batch deploy calls `deployManifest` **directly** under `runBatchWithConcurrency` (never through a caller-side sign-lock — the SDK holds the broadcast lock internally; see Transaction Path). A batch result has **four** buckets, not two: `succeeded`, `failed`, `unconfirmed`, `cancelled`. An `executeOne` returns a `BatchResultItem` whose optional `outcome` picks the non-default bucket — `'unconfirmed'` (the provider was asked but never gave a verdict — deploy's readiness-unconfirmed arm and restart's unanswered readiness wait; rendered under the caller's `unconfirmedLabel`, `Still deploying` / `Still restarting`) or `'cancelled'` (the signal aborted **before** the non-idempotent call, so the app is unchanged and the registry is NOT marked failed). Entries never queued when the signal aborts mid-run are bucketed `cancelled` too, so the summary counts every entry. `summarizeBatchResult` keys both the OVERALL progress phase and the success/failure verdict off one `nothingLanded` predicate (`succeeded` and `unconfirmed` both empty), so the ProgressCard and the chat text cannot disagree — an all-unconfirmed batch paints `'ready'` and returns `success: true`. Every count segment is conditional (no `0 failed`), the `All N apps deployed!` headline fires only when `succeeded` is the sole segment, and an empty batch reads `No apps <verb>`. `computeOverallPhase` — which drives the INTERMEDIATE emits — is deliberately **not** outcome-aware: `DeployProgress['phase']` has no non-terminal value meaning "we never found out", and `ProgressCard` only settles on `'ready'`/`'failed'`, so an unconfirmed row's per-app phase stays `'failed'` while the distinction survives in the counts and summary text
   - **Failure guidance** (`failureGuidance.ts`): `nextStepFor(reason, appName)` — the **single source of truth** for every next-step string barney shows. Relays the SDK's curated `FRED_REASON_GUIDANCE[reason].nextStep` verbatim except for `ContainerExited` / `Unknown` / `RestoreFailed`, whose SDK sentences name `get_logs({ lease_uuid, tail: 200 })` and `restore_app` — a call shape barney's `get_logs(app_name)` rejects and a tool barney does not have. Those three keep the SDK's tool-free `explanation` as their lead and substitute only the actionable half. Gates **only** on `isKnownFailureReason` (fred's reason set is open and add-only): an unrecognized/absent reason yields `undefined` — omit the next step, never fake one — while `reason` itself is still relayed verbatim. Three sinks, all wired here: `app_diagnostics` (`compositeQueries.ts`), the deploy-failure prose (`deployError.ts`), and the update-failure copy (`compositeTransactions.ts`). Never call the SDK's `guidanceFor` directly from a display site
   - **Helpers** (`helpers.ts`): Shared functions — `extractPrimaryServicePorts`, `formatConnectionUrl`, `deriveUrlFromConnection` (shapes the app URL from `DeployResult.connection` with no extra round-trip), `failureText` (the single display-boundary rendering of a fred failure pair: `failureDetail` for dual-era `reason`/`message` ↔ `last_error`/`error`, then `sanitizeForDisplay`)
   - **Provision status** (`provisionStatus.ts`): the **single** reading of fred's `provision_status`, shared by `app_status` (`compositeQueries.ts`) and the update rollback gate (`compositeTransactions.ts`) — the two had each hand-maintained a status set and had already drifted. `classifyProvisionStatus(status)` → registry `provisionState`; `isUnsettledProvisionStatus(status)` → "carries no verdict", derived as SDK `PROVISION_IN_PROGRESS` **minus** the failure verdicts so a status a newer fred adds reaches both consumers at once. `failing` is a **verdict** here even though the SDK lists it under `PROVISION_IN_PROGRESS`: that set is a POLL rule (keep waiting for the settle to `failed`), while fred enters `Failing` only from `Ready` on `evContainerDied` and stamps `Reason: ContainerExited` synchronously. An unmodelled value is deliberately NOT unsettled — fred's vocabulary is open and add-only, so the default is "trust the verdict that came with it", not silence; an ABSENT status IS unsettled (`omitempty` drops it when a degraded provider's provision lookup fails)
   - **ADR-036 auth**: consolidated to a single `createProviderAuth` minter built once at the `useManifestMCP` root (`src/hooks/useManifestMCP.ts`). `authTokens` is a thin address-binding adapter over that same instance (`src/hooks/authTokensAdapter.ts`); `providerAuth` and the separate server-challenge signer `relayAuth` are required fields on `SigningContext`. `deployManifest` handles payload upload + SHA-256 hashing internally, so barney's old `toolExecutor/utils.ts` (`uploadPayloadToProvider` / `computePayloadHash`) was deleted
   - **Escape hatches**: `cosmos_query` and `cosmos_tx` are handled separately (not in the QUERY_TOOLS/TX_TOOLS sets)
   - **Internal pseudo-tool**: `batch_deploy` — orchestrates multi-app deploys from the UI. Not declared in `AI_TOOLS` and never exposed to the model; routed through `executeConfirmedTool` (case `'batch_deploy'`) by the `requestBatchDeploy` AI store action (e.g. `useAI().requestBatchDeploy`)

### 17 Composite Tools

| Tool | Type | Description |
|------|------|-------------|
| `deploy_app(app_name?, size?, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?, custom_domain?, service_name?)` | TX | Deploy from attached manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image`. `custom_domain` attaches a domain in the same TX flow (single-step deploy + DNS); `service_name` picks the target service in a multi-service stack. The `size` enum is rebuilt at prompt-build time from the resolved SKU tier list (chain ∩ `PUBLIC_SKU_SPECS`); default size is the cheapest available tier (lowest normalized `$/hour` via `getCheapestTier(tiers)` in `src/api/skuTiers.ts`). The executor resolves size via `resolveSizeOrCheapest`: an omitted **or unavailable** size falls back to the cheapest tier; it returns `Tier catalog unavailable — try again in a moment.` only when the resolved tier list is empty |
| `stop_app(app_name)` | TX | Stop apps by name, comma-separated list (e.g. "redis,postgres"), or "all" to stop all running apps |
| `fund_credits(amount)` | TX | Add credits in display units |
| `restart_app(app_name)` | TX | Restart apps by name, comma-separated list, or "all" to restart all running apps. An abort that lands **at** the POST (the SDK's `restartApp`/`updateApp` re-check the signal after minting the ADR-036 token, before the non-idempotent request) is reported as cancelled — `"…was cancelled before the provider was asked; the app is unchanged."` — and the registry is **not** marked `failed`. In a batch it buckets as `cancelled`, not `failed` |
| `update_app(app_name, image?, port?, env?, user?, tmpfs?, command?, args?, services?, health_check?, stop_grace_period?, init?, expose?, labels?)` | TX | Update app with new manifest, Docker image, or service stack. `services` (JSON) is mutually exclusive with `image`. Same abort-at-the-POST handling as `restart_app`. A post-update `/provision` read is trusted UNLESS `provision.status` is one of fred's genuinely mid-flight values (`UNSETTLED_PROVISION_STATUSES` = `provisioning`/`restarting`/`updating`/`unknown`) or absent, in which case it falls through to the best-effort success path — fred's `applyReplaceEntry` does not clear a retained prior `reason`/`message`, and the readiness wait can resolve early when a degraded provider omits `provision_status`. The gate is a NEGATIVE list on purpose (G2): fred's `ProvisionStatus` block is add-only, so an unmodelled status must default to "trust the verdict", not to silence. That is also what makes the transient `failing` — written synchronously by `onEnterFailing` with `reason: ContainerExited` before the async diagnostics gather flips it to `failed`, and entered ONLY from `Ready` — read as the container-died-after-a-successful-update verdict it is. An `ImagePullFailed` is fred's **preflight** (`doUpdate` returns before `doReplaceContainers`), so the registry keeps fred's `failed` verdict and the copy leads with the failure and its cause, keeping "nothing was changed on the provider" as blast-radius reassurance rather than a claim about what is serving — never "rollback failed", and never "is still running" (G3: chat must not assert a state the badge contradicts) |
| `set_custom_domain(app_name, custom_domain, service_name?)` | TX | Attach, change, or clear (`custom_domain=""`) a per-LeaseItem custom domain. Surfaces a `CustomDomainCard` post-broadcast with DNS status polling |
| `list_apps(state?)` | Query | List apps filtered by state (default: running). Re-observes the chain for EVERY app in BOTH directions — records `chainState: 'active' \| 'pending' \| 'absent'` rather than only latching the negative — and keeps PENDING distinct from ACTIVE (a pending lease derives `deploying`, not `running`). Never touches `provisionState`: it has no provider evidence |
| `app_status(app_name)` | Query | Detailed status: registry + chain + fred. Records BOTH observations it makes — `chainState` from the chain lease (`active`/`pending`/`absent`, the PENDING branch matching `list_apps` and `reconcileWithChain`) and `provisionState` from fred's `provision_status` (via `classifyProvisionStatus`: the SDK's `PROVISION_SUCCESS` → `confirmed`, `PROVISION_FAILED` → `failed`, `PROVISION_IN_PROGRESS` and `retained` → `unconfirmed`, anything in none of those sets → no observation). An in-flight reading fills a gap but never RETRACTS an existing `confirmed`; `retained` does, because the workload really is gone. Emits a `CustomDomainCard` (single-domain status / consolidated multi-domain / no-domain form with stack picker) |
| `get_logs(app_name, tail?)` | Query | Container logs for an app. Refuses **only** `stopped` apps (the lease is gone, so the lease-scoped ADR-036 token authenticates against nothing) — the same single refusal rule `app_diagnostics` and `app_releases` use. A `failed` or `deploying` app is served: fred keeps the lease and its containers through a failed provision, and that is exactly when logs are wanted |
| `get_balance()` | Query | Credits, spending rate, time remaining |
| `browse_catalog()` | Query | Providers + SKU tiers with health checks. Each provider row carries `healthy` (true only for the exact verdict `healthy` — the honest default, since a chain-impaired `degraded` fails every lease-resolving endpoint), plus the diagnosis: `health_status` (the provider's raw verdict, or the literals `unreachable` / `no_api_url`) and `healthError` (the failing `checks`, summarized) when not healthy. The verdict tier is an OPEN set — echo it verbatim, never `switch` on it |
| `lease_history(state?, limit?, offset?)` | Query | Paginated on-chain lease history with state filtering |
| `app_diagnostics(app_name)` | Query | Provision diagnostics: status, fail count, and the failure pair — `reason` + `message` (fred ENG-508), with the deprecated `last_error` still echoed when a pre-v0.13.0 provider sends it, plus `next_step` when `nextStepFor` (see `failureGuidance.ts`) has barney-shaped guidance for that reason. Refused only for a `stopped` app; a `failed` app is exactly when diagnostics are wanted |
| `app_releases(app_name)` | Query | Release/version history for an app. Same refusal policy as `app_diagnostics`: only a `stopped` app is refused — a `failed` app still has a release history, and that history is what tells the user which version the provider is actually running (the ENG-619 indeterminate-update copy points here) |
| `request_faucet()` | Query | Request free PWR (gas + credits) and MFX tokens from the faucet (24-hour cooldown per token) |
| `cosmos_query(module, subcommand, args?)` | Query | Raw chain query escape hatch |
| `cosmos_tx(module, subcommand, args)` | TX | Raw chain TX escape hatch |

Tool definitions: `src/ai/tools.ts` (static base `AI_TOOLS` + `buildAITools(tiers)` builder — the builder is what `sendMessage` ships to the model, with `deploy_app.size.enum` injected from the resolved tier list; passing `[]` omits the enum so the executor's "Tier catalog unavailable" rejection is the single failure mode). System prompt: `src/ai/systemPrompt.ts` (signature is `getSystemPrompt(address?, tiers?)` — the tier block is rendered from `tiers`). Known Docker images and stacks: `src/ai/knownImages.ts`. In-app `/help` content: `src/ai/helpText.ts` (signature is `buildHelpText(skuTiers: SkuTiersState)` — the resource-tiers table is rendered from `skuTiers.tiers`; an empty list produces phase-distinct copy: `error` → "Tier catalog unavailable: \<error\>"; `loading` → loading status row; `idle` → "not loaded yet"; defensive empty `ready` → "no tiers configured").

### Manifest Generation (`src/ai/manifest.ts`)

Thin wrappers around the SDK deploy facade's manifest builders (`@manifest-network/manifest-sdk/deploy`), adding Barney-specific behavior: port string normalization, password generation for empty env values, tmpfs/expose string splitting, SHA-256 payload hashing, and `BuildManifestResult` wrapping.

- `buildManifest(opts)` — Build single-service manifest JSON, compute hash, return `BuildManifestResult`. Delegates to fred's `buildManifest()`
- `buildStackManifest(opts)` — Build multi-service stack manifest with `{ services: {...} }` format, compute hash
- `mergeManifest(newManifest, oldManifestJson)` — Merge old manifest fields into new, graceful fallback on parse error. Delegates to fred's `mergeManifest()`
- `validateServiceName(name)` — RFC 1123 DNS label validation, returns error string or null. Wraps fred's boolean return
- `normalizePorts(port)` — Parse port string to `PortOptions`-valued ports record (Barney-local, returns `PortOptions` instead of fred's `Record<string, never>`)
- `deriveAppNameFromImage(image)` — Extract app name from Docker image ref (Barney-local, different from fred which includes tags)
- `isStackManifest(manifest)` / `parseStackManifest(json)` / `getServiceNames(manifest)` — Stack manifest utilities (Barney-local, use `{ services: {...} }` format vs fred's flat format)
- `ServiceConfig` — Type alias for `BuildManifestOptions`, used per-service in stacks

### Known Images & Stacks (`src/ai/knownImages.ts`)

- `KNOWN_IMAGES` — Readonly array of known Docker image configs with default ports, env, user, tmpfs, health_check, etc.
- `findKnownImage(imageRef)` — Lookup known image config by Docker image reference
- `KNOWN_STACKS` — Readonly array of pre-built multi-service stack configs (WordPress, Ghost, Adminer-Postgres) with `depends_on` ordering and aliases (e.g., `wp`, `pgadmin`)
- `findKnownStack(name)` — Lookup known stack by name or alias
- `generateImageReferenceForPrompt()` / `generateStackReferenceForPrompt()` — Generate reference text injected into the AI system prompt

### App Registry

`src/registry/appRegistry.ts` — localStorage-backed name→lease mapping, scoped per wallet address.

```
Key: barney-apps-{address}
AppEntry { name, leaseUuid, size, providerUuid, providerUrl, createdAt, url?, connection?, manifest?,
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
and runs on every mutation (`addApp`, `updateApp`, `reconcileWithChain`), so the ~86 `.status` read
sites are untouched. Precedence: provider `failed` → `failed`; chain `absent` → `stopped` (a legacy
entry already recorded `failed` stays `failed`); provider `unconfirmed` → `deploying`; provider
`confirmed` → `deploying` if the chain is `pending`, else `running`; with no provider observation,
chain `active` → `running`, `pending` → `deploying`, nothing → the stored legacy `status` verbatim.

`reconcileWithChain` observes ONE thing and writes ONE field (`chainState`). It contains no
status-promotion branch: a chain lease being ACTIVE says nothing about whether the provider ever
provisioned the workload (fred v0.13.0 `internal/provisioner/reconciler.go` only closes a failed
lease after `FailCount >= maxReprovisionAttempts`), so the old `failed → running` /
`deploying → running` promotions reverted the deploy path's provider verdicts within one 15s
sidebar tick.

**Observations must be REFRESHABLE, not one-way latches.** A field a writer can set but never
re-clear is a latch, and a latch defeats the level-triggered model this refactor exists to build
("fields in status should be the most recent observations of actual state"). The re-observation
points, by field:

| Field | Re-observed by | Cadence |
|-------|----------------|---------|
| `chainState` | `reconcileWithChain` (AppsSidebar refresh), `list_apps`, `app_status` | 15s timer + on tool call |
| `provisionState` | `app_status` only | on tool call |

`provisionState` having exactly one re-observation point is the model's remaining asymmetry: a user
who never runs `app_status` can sit on a stale `unconfirmed`. `app_status` is therefore the
**sanctioned refresh point** — the guard messages on `restart_app` / `update_app` name it explicitly,
and it clears a stale `unconfirmed`/`failed` the moment fred reports ready again.

**`updateApp` splits PERSIST from NOTIFY**, which is what makes re-observation affordable at all.
`dirty` (any real value change) decides whether to write; `visible` decides whether to `notify`.
A write touching only `OBSERVATION_ONLY_FIELDS` (`chainState`, `provisionState` — the two fields no
subscriber renders) persists **silently** unless it moves the derived `status`; a write that changes
nothing does nothing at all — no `JSON.stringify`, no localStorage write, no notify. Without the
split, a writer on a 15s timer could only afford to record the NEGATIVE observation, which is
precisely how the latch arose. Two rules for anyone extending `AppEntry`:

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

Functions: `getApps`, `getApp`, `findApp`, `getAppByLease`, `addApp`, `updateApp`, `removeApp`, `reconcileWithChain`, `deriveAppStatus`, `validateAppName`, `sanitizeManifestForStorage`.

Name rules: lowercase, alphanumeric + hyphens, 1-32 chars, unique per wallet.

### Deploy Progress

`src/ai/progress.ts` defines `DeployProgress` with phases:
`creating_lease → uploading → provisioning → ready | failed`
Additional phases for restart/update operations: `restarting`, `updating`
The `operation` field (`'deploy' | 'restart' | 'update'`) indicates the current operation type for UI display.

Progress is reported via `onProgress` callback in `ToolExecutorOptions`, stored in the AI store as `deployProgress`, and rendered by `ProgressCard`. Batch deploys include a `batch` array with per-app progress.

### Fred API Client

`src/api/fred.ts` — thin HTTP-function wrappers for lease deployment status.

The five wrappers (`getLeaseLogs`, `getLeaseProvision`, `getLeaseReleases`, `restartLease`, `updateLease`) delegate to the SDK deploy facade (`@manifest-network/manifest-sdk/deploy`) with Barney's CORS proxy/SSRF `fetchFn` adapter (`src/api/providerFetchAdapter.ts`) + the DEV `allowLoopback` flag injected. Use `getLeaseLogs`, never `getAppLogs` (the latter's 4000-char cap clips the full-logs LogCard). As of ENG-774 `restartLease` / `updateLease` are no longer on any app path — `restart_app` / `update_app` go through the SDK's `restartApp` / `updateApp` primitives (see Transaction Path); the two wrappers remain as the raw HTTP escape hatch.

The live lease-status WebSocket path is no longer barney-local (ENG-312 Phase 6): restart/update wait via the SDK's `waitForLeaseStatus` with an injected browser `EventTransport` (`src/api/eventTransport.ts`) — the SDK owns reconnect/backoff/liveness/poll-fallback; `eventTransport.ts` only reshapes the URL for the dev `/proxy-provider` tunnel (prod connects direct, SSRF-validated) and adapts the native `WebSocket` to the SDK's `EventSocket`.

### Transaction Path

The TX path splits by tool:

- **`deploy_app` / `batch_deploy`** — delegate to the SDK's `deployManifest` primitive (imported from the `@manifest-network/manifest-sdk/deploy` facade), which runs create-lease (via `cosmosTx` internally) → optional set-domain → payload upload → provision-poll as one call. barney no longer hand-rolls this spine.
- **`stop_app`** — the SDK's `stopApp(ctx, { leaseUuid }, opts)` primitive from `@manifest-network/manifest-sdk/deploy` (ctx is a `TxCtx` = `{ chain: clientManager, logger: noopLogger }`). It pre-queries the authoritative on-chain state and dispatches ACTIVE→close-lease / PENDING→cancel-lease / terminal→no-op, so idempotency is internal (`outcome: 'already_inactive'`) — barney no longer string-matches a `rawLog`. Single stop uses `waitForConfirmation: true` (blocks for the authoritative outcome); bulk "stop all" uses `waitForConfirmation: false` (async SYNC/CheckTx broadcast, hash-only) so it doesn't serialize N block confirmations — the registry is marked `stopped` optimistically and `reconcileWithChain` corrects any DeliverTx-level failure later.
- **`fund_credits` / `cosmos_tx`** — `cosmosTx()` from `@manifest-network/manifest-sdk/chain` (billing `fund-credit`, or the raw escape hatch). Uses manifestjs internally.
- **`update_app` / `restart_app`** — the SDK's `updateApp` / `restartApp` lifecycle primitives from `@manifest-network/manifest-sdk/deploy` (ENG-774), always called as `(ctx, input, { pollOptions: false, providerUrl, signal })`; no chain TX. `pollOptions: false` makes each primitive return straight after the provider POST so barney keeps its own `waitForLeaseStatus` + ProgressCard (and, for update, the rollback gate); `providerUrl` selects the primitives' fast path — omit it and each call silently adds two chain reads (`fetchActiveLease` + `resolveProviderUrl`). What barney gains over the old raw `updateLease` / `restartLease` HTTP wrappers is the `throwIfAborted` guard immediately before the non-idempotent POST (the bulk restart loop had none) and — update only — `rethrowIndeterminate`: a `ProviderApiError` with `status >= 500` becomes `ManifestMCPErrorCode.UPDATE_INDETERMINATE`, because fred answers 500 both when it refuses before the backend AND when the backend already applied the update but persisting the payload failed (ENG-619). 4xx rethrows untouched, so the 409 branch is unaffected. There is NO `rethrowIndeterminate` on `restartApp`.
  A readiness-**wait** rejection (single restart, batch restart, or update) records
  `provisionState: 'unconfirmed'` — derived `deploying` — never `'failed'`. `waitForLeaseStatus`
  RESOLVES at every terminal state including an observed failure, so its rejections (poll deadline,
  transport error, lease-not-found, abort) carry no provider verdict at all; the one exception is a
  `ProviderApiError` with `kind: 'poll_verdict'`, which does, and records `'failed'`. Blanket-`failed`
  used to badge a healthy app as failed whenever a slow provider outran the wait budget — worst on
  `restart all`, where N waits share one budget. The `deploying` that `'unconfirmed'` derives means
  `update_app`'s `running|failed` guard now refuses a retry, so both guard messages point the user at
  `app_status("<name>")` to re-observe first. The guards were deliberately NOT widened to admit
  `deploying`: pushing a manifest at a lease that may still be provisioning races the provisioner.
- **`set_custom_domain`** — `setItemCustomDomain` from `@manifest-network/manifest-sdk/deploy` (standalone tool only; the deploy path attaches domains atomically *inside* `deployManifest`).

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
| `provider-api.ts` | Auth helpers, health check, connection info — delegates to `@manifest-network/manifest-sdk/deploy` with CORS proxy/SSRF adapter **and the DEV `allowLoopback` flag** (`getProviderHealth` 4th positional, `getLeaseConnectionInfo` 5th — the SDK validates the URL before it ever consults `fetchFn`, so omitting it breaks DEV outright). Keeps `validateAuthTimestamp` and null-returning `getProviderHealth` locally |
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
| `aiActions/persistence.ts` | `loadSettings`, `loadHistory`, persistence subscriptions |
| `aiActions/skuTiers.ts` | `loadSkuTiers` / `retrySkuTiers` — boot-time SKU resolution. Parses `PUBLIC_SKU_SPECS`, calls `resolveSkuTiers()`, writes the `SkuTiersState` slice (`phase: 'idle' \| 'loading' \| 'ready' \| 'error'`, `tiers`, `denomSymbol`, `error`). Concurrent calls dedupe via the store's `_skuTiersInFlight` promise field. `retrySkuTiers` is a no-op from `ready` (consumers read `skuTiers.tiers` without phase-guarding, so transitioning `ready → loading` would leak stale tiers to in-flight chat/tool execution); from `idle`/`loading`/`error` it resets phase and re-issues the fetch. Used by the Retry button on `ChatPanel`'s tier-error banner. |
| `aiActions/stopApp.ts` | `requestStopApp` (synthesizes a `stop_app` pendingConfirmation from a UI surface) |
| `aiActions/utils.ts` | `generateMessageId`, `trimMessages`, `createAssistantMessage`, `toChatApiMessages`, `getAppRegistryAccess` |

`AIProvider` (`src/contexts/AIContext.tsx`) is a thin lifecycle wrapper that sets up persistence subscriptions, health checks, confirmation timeouts, fires `loadSkuTiers()` once on mount, and on unmount calls `store.getState().destroy()` and `disposeReadClient()` (`src/api/readClient.ts`).

**`skuTiers` slice on the store** (`aiStore.ts`): the resolved SKU tier list lives here as `SkuTiersState`. Deploy surfaces are **never disabled** by tier state — example-app buttons, sidebar re-deploy, and `ConfirmationCard` Confirm always render enabled. The executor and `ConfirmationCard` share `resolveSizeOrCheapest` (`src/api/skuTiers.ts`) so an omitted/unavailable size deploys on the cheapest tier; the card shows the resolved tier's price + specs (`formatTierSpecs`) and names any substitution (a `'cheapest-unavailable'` fallback). An empty tier list yields the executor's inline `Tier catalog unavailable` error (with a `Retry` → `retrySkuTiers`) — the single failure mode. The executor (`compositeTransactions.ts` `executeDeployApp` / `executeBatchDeploy`) reads the resolved list from `ToolExecutorOptions.tiers` rather than calling `resolveSkuTiers` itself — `confirmAction` + `batchDeploy` + `toolExecution` thread `get().skuTiers.tiers` into each call so the executor stays pure.

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
| `useRegistryApps` | `useSyncExternalStore` view of the wallet's app registry, kept live via `subscribeToRegistry`. Used by `MainLayout` to feed the DNS polling driver |
| `useVisibilityPolling` | Visibility-aware polling with optional exponential backoff. Pauses on tab hidden, resumes on focus. Used by `AIProvider` (health check) and `AppsSidebar` (refresh) |

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
| `connection.ts` | `collectInstanceUrls` — per-instance FQDN URL collection with hostname validation (`isValidFqdn`) |
| `tx.ts` | Transaction event parsing utilities (extract attribute values from TX events) |
| `versionedStorage.ts` | Versioned localStorage with schema migrations (envelope format, upgrade chain) |
| `customDomainStatus.ts` | Custom-domain status computation (`computeStatus` → `CustomDomainStatusReport`; `CustomDomainStatusKind`, DNS/HTTPS probe result types) |
| `customDomainValidation.ts` | Custom-domain FQDN validation (`validateCustomDomainFormat`, `isApex`, `isReservedSuffix`, `apexRecordKindLabel`, `APEX_WARNING`) |
| `cn.ts` | Re-exports `clsx` as `cn`: `cn('foo', condition && 'bar')` |

### Constants (`src/config/constants.ts`)

All tunable timeouts, cache sizes, and limits are centralized here. Key values:

| Constant | Value | Purpose |
|----------|-------|---------|
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
| `MAX_PAYLOAD_SIZE` | 5KB | Maximum file upload size (in `hash.ts`) |
| `FRED_POLL_INTERVAL_MS` | 3s | Default polling interval for Fred status checks (passed as `waitForLeaseStatus`'s `intervalMs`) |
| `DNS_POLL_INTERVAL_MS` | 30s | Polling interval for browser-side DNS / HTTPS probes (`useDnsStatusPolling`) |
| `DNS_STUCK_THRESHOLD_MS` | 5min | Show "verify with dig locally" hint after sustained `pending_dns` (only when slice has no `detail`) |
| `AUTO_REFRESH_INTERVAL_MS` | 15s | Auto-refresh interval for sidebar data polling |
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
- **Chat persistence**: The AI store persists settings and chat history to localStorage (`barney-ai-settings`, `barney-ai-history`) via Zustand subscriptions. History is validated and sanitized on load; corrupted data is cleared. Streaming messages are excluded from persistence.
- **Confirmation timeout**: Pending transaction confirmations auto-cancel after `AI_CONFIRMATION_TIMEOUT_MS` (5 minutes) to prevent stuck UI state.
- **UI-direct store actions**: Actions that synthesize a `pendingConfirmation` from a UI surface (e.g. `requestStopApp`, `requestBatchDeploy` in `src/stores/aiActions/`) MUST gate on `pendingConfirmation !== null` before constructing the new action. Without the gate, a click while another confirmation card is open silently overwrites the store's pending action and orphans the prior tool message (`awaitingConfirmation: true`, no path to confirm/cancel — chat wedged). Matches the standard modal-overlay UX: background clicks are inert at the action layer.
- **App registry scoping**: Registry is per-wallet in localStorage. `AppShell` syncs wallet changes and clears deploy progress on disconnect.
- **Registry status is DERIVED, never written**: writers record the OBSERVATION they actually made — `chainState` from a chain read, `provisionState` from a provider read — and `deriveAppStatus` turns those into the `status` summary on every mutation. Never pass `status` to `addApp`/`updateApp` from a writer that has an observation; the only surviving `status:` writes are the observation-free seed in `onLeaseCreated` and the two `deployError.ts` chain-verdict fall-throughs whose verdict cannot be attributed to a single source. **A writer with no observation must write neither field**: abort/cancel paths (the provider was never asked), `UPDATE_INDETERMINATE` (fred's 500 is ambiguous by construction), and **every POST-site catch on `restart_app` / `update_app`** (single and batch) leave the entry exactly as it was — having no observation IS the state. That last one is the rule applied evenly: an operation refused, aborted, or never sent is not an observation about the workload. Everything reaching those catches — a pre-POST ADR-036 mint failure, a transport error, a 4xx refusal, or a restart 5xx, which fred returns from `routeReplaceRestart`'s prelude *before* the lease-actor handoff so no container is touched — says nothing about whether the app is up, and writing `'failed'` there dropped a healthy app out of `list_apps(running)`, `restart_app` and DNS polling. The OPERATION is still reported failed (same `onProgress` phase, same error string, same batch `Failed:` bucket); only the registry write is withheld. `'unconfirmed'` is not the compromise — it derives `'deploying'` and gates the app out of the same tools. Corollary: `stop_app` records `chainState: 'absent'` only, so an app that failed to deploy and was then stopped still reads `failed` — the stop does not erase a diagnosis it never disproved.
- **Abort guards key on the ERROR, not on the signal**: use `isAbortError(err)` (`compositeTransactions.ts`), never a bare `signal?.aborted`. The chat controller is aborted by ANY new user message (`aiActions/sendMessage`), so an ambient check relabels a genuine provider failure that merely coincides with typing as "cancelled before the provider was asked; the app is unchanged" — and skips the registry write, losing the failure entirely. `signal.throwIfAborted()` throws a `DOMException` named `AbortError`, which is what the SDK primitives raise from their pre-POST guard. The primitives do NOT thread the signal into the POST itself (`restartLease`/`updateLease` take no signal), so an `AbortError` really does mean the provider was never asked — which is what licenses that copy. At a readiness-WAIT site the POST already landed, so an abort there is still a cancellation (batch restart returns `outcome: 'cancelled'`, G4) but the copy says only that we stopped waiting, never that nothing happened.
- **An unmodelled provider verdict defaults to being trusted**: fred's `ProvisionStatus` and `Reason` sets are open and add-only, so gates over them are written as NEGATIVE lists — name the values that carry no verdict (`isUnsettledProvisionStatus`, `provisionStatus.ts`) or that the operation can be blamed for (`UPDATE_ATTRIBUTABLE_REASONS`) and let everything else fall to the conservative arm. A positive allowlist makes every value fred adds later silently report success. Same open-set discipline as `browse_catalog`'s health verdict.
- **Error UX boundary**: Two error surfaces by design. **Toasts** (`useToast` + `ToastContainer`) are reserved for surfaces that exist *before* the chat panel mounts — wallet connection errors (popup blocked / closed / network) in `AppShell`. Once the user is connected, all errors flow through **chat messages** (`error` field on `ChatMessage`, surfaced as inline alerts with `ERROR_PATTERNS` regex-matched "Try again" suggestion buttons in `MessageBubble.tsx`). Tool failures, deploy failures, signing rejections, payload validation, manifest parse errors all land in chat. Don't add new toasts post-connect — push errors into chat.
- **Custom-domain DNS state**: All four custom-domain surfaces (sidebar dot, deploy success pill, single-domain card, multi-domain consolidated card) read DNS status from a single source — `aiStore.dnsStatuses`. The map is populated by `useDnsStatusPolling`, mounted exactly once in `MainLayout` (deliberately outside the sidebar's `ErrorBoundary` — a sidebar render error must not take DNS state down with it). No surface runs its own polling loop. Adding a new surface means reading `dnsStatuses.get(dnsStatusKey(leaseUuid, fqdn))`, not adding another `useVisibilityPolling`.
- **SKU tier resolution**: Single source of truth is `aiStore.skuTiers` (slice produced by `loadSkuTiers`, kicked off once in `AIProvider`). The resolved tier list is chain ∩ `PUBLIC_SKU_SPECS` — chain owns SKU names + per-`Unit` prices (normalized to `$/hr` in `hourlyPriceFromSku()`), env owns CPU/RAM/disk. Session-lifetime cache — no periodic refresh. All deploy-related surfaces read from the slice: `deploy_app.size.enum` (`buildAITools(tiers)`), `/help` table (`buildHelpText(skuTiers)`), system prompt tier block (`getSystemPrompt(addr, tiers)`), `ConfirmationCard` price/specs row, executor (`compositeTransactions.ts` reads `options.tiers`). No gating: deploy surfaces (`ChatPanel` example-app buttons, `AppsSidebar` re-deploy, `ConfirmationCard` Confirm) are never disabled by tier state. The executor + `ConfirmationCard` share `resolveSizeOrCheapest` — an omitted or unavailable size resolves to the cheapest tier, and the card discloses the resolved tier's price + specs (`formatTierSpecs`) plus a substitution note when an explicitly-requested size isn't offered (`fallback === 'cheapest-unavailable'`). An empty tier list is the only hard failure: the executor returns `Tier catalog unavailable — try again in a moment.`, surfaced inline in chat with a `Retry` (`MessageBubble` `ERROR_PATTERNS` → `retrySkuTiers`). This is also the single failure mode for `buildAITools([])` omitting the `size.enum`.

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
