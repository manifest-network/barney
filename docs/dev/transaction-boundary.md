# SDK transaction boundary

Barney plans and previews product actions, obtains user confirmation, then calls typed Manifest SDK operations. The model cannot select arbitrary chain messages, transaction commands, recipients for credit funding, or fee overrides. Unsupported transfers, staking, governance, and credit withdrawals remain unavailable until a reviewed high-level SDK capability and purpose-built Barney tool exist.

## Transaction inventory (ENG-830)

Reviewed against the pinned `@manifest-network/manifest-sdk` 0.23.0. There are no direct `cosmosTx`, `executeTx`, signing-client, or low-level broadcast calls in Barney product code. `src/build/transactionBoundary.test.ts` guards this boundary.

| Product action / caller | SDK operation | Approval data | Validation, fees, and cancellation |
| --- | --- | --- | --- |
| Single and batch deploy (`compositeTransactions.ts`) | `deployManifest` | App, tier/provider, manifest, optional service/domain; batch also binds prices and hashes | Manifest and domain syntax validated before create-lease; up to two chain transactions per app; `abortSignal` reaches the SDK |
| Single and bulk stop (`compositeTransactions.ts`, sidebar request in `stopApp.ts`) | `stopApp` | Explicit app names and lease IDs resolved before approval | At most one transaction per app; `signal`; bulk uses CheckTx and reconciles later |
| Chat credit funding (`compositeTransactions.ts`) | `fundCredits` | Positive PWR amount and bound wallet address | One transaction; `signal`; no tenant or fee override |
| First-connect account setup (`useAccountSetup.ts`) | `fundCredits` | Fixed application-policy amount, SDK defaults recipient to signer | One transaction per attempt; setup `signal` on initial call and retry; automatic faucet-enabled onboarding, outside chat consent |
| Restart (`compositeTransactions.ts`) | `restartApp` | App names, lease IDs, provider URLs | Provider-only operation; `signal` |
| Update (`compositeTransactions.ts`) | `updateApp` | App, lease/provider, final manifest | Final manifest and encoded request size validated before provider authentication/POST; no chain transaction; `signal`; indeterminate-update/rollback handling retained |
| Attach/change/clear domain (`compositeTransactions.ts`) | `setItemCustomDomain` | App/lease, service, previous and requested domain | One transaction; `signal` |
| Provider/relay authentication (`useManifestMCP.ts`) | `createProviderAuth` / wallet ADR-036 proof | Wallet-bound off-chain authentication | No chain transaction or network fee |
| `src/api/tx.ts` | None | Shared types and enum re-export | No signer or broadcast implementation |

The last direct product billing call, chat credit funding, now uses `fundCredits`. Lifecycle migration prerequisites are already delivered: [ENG-494](https://linear.app/liftedinit/issue/ENG-494) supplies asynchronous stop, and [ENG-488](https://linear.app/liftedinit/issue/ENG-488) supplies cached-provider restart/update. Every retained action has an SDK operation; no missing-operation issue or raw fallback is needed. Future missing capabilities require a narrowly scoped SDK issue before exposing a new Barney action.

## Planning and execution

SDK 0.22 canonicalizes custom-domain whitespace and case with `parseFqdn` and rejects malformed domains before chain reads or the credit-reserving create-lease broadcast. Chain policy, including reserved suffixes and existing claims, remains authoritative at the later set-domain transaction.

The SDK validates the final update payload before authenticating or calling the provider. This includes duplicate JSON keys, decimal/exponent spellings for Go integer fields, manifest admission rules, and the base64 request envelope size. A stack update must contain only the top-level `services` field. Barney retains its stricter 5 KB payload limit. These preflight failures do not submit an update; post-POST uncertainty and rollback handling remain separate.

`deployManifest` now awaits `onLeaseCreated` inside its partial-deploy catch, before assigning a `failedStep`. A partial error without a step therefore means no manifest was uploaded, whether caused by cancellation or a callback failure. Barney captures the paid lease before notifying observers, isolates synchronous and asynchronous progress errors, and records the no-upload outcome as failed. An unrecognized partial step remains unconfirmed; an ACTIVE chain lease alone cannot turn it into a readiness verdict.

`transactionPlans.ts` defines strict typed semantic schemas. `transactionConfirmation` parses and freezes each plan for display, and the confirmed executor parses that same schema again before any SDK mutation. The sidebar's direct stop action uses the same helper. Batch deploy retains its canonical planner and confirmation-time hash, catalog, and aggregate-balance checks. Intermediate model batch drafts are not directly confirmable. Failed batch-edit feedback is removed from the arguments before dispatch, so reverting edits can confirm the original plan without weakening the schema.

Credit funding retains only the PWR display amount and wallet address. Both phases reject non-positive, non-finite, excessive-precision, and unsafe-base-unit amounts. Confirmation derives the SDK coin string with decimal-safe conversion, verifies the wallet binding, and omits `tenant` so the SDK funds the signer. SDK cancellation retains the distinction between not submitted and possibly submitted; uncertain transfers require a balance check before retrying.

The wallet manager receives `MAX_TRANSACTION_GAS = 50_000_000`. SDK simulation rejects estimates above that ceiling before signing. At the configured `GAS_PRICE`, `transactionFees.ts` calculates the maximum fee shown by `ConfirmationCard`, including batch totals and optional deploy domain transactions. Invalid fee configuration displays an inline error and disables confirmation while preserving cancellation. No tool can override the gas ceiling, gas price, or explicit fee. SDK methods retain typed result/error contracts; Barney maps them into chat results while preserving existing lifecycle uncertainty handling.

Web3Auth's `promptSign` automatically accepts SDK signature requests. It is not a human approval boundary. Chat approval is consumed once in `confirmAction`, with wallet/chain/client/signer generation checks and cancellation before dispatch and each SDK mutation. Account setup and off-chain authentication follow the separate policies in [security](security.md#5-transaction-confirmation).

## Regression coverage

### Fred PR 240 maintenance (ENG-976)

`capabilityCtx.ts` carries an explicit provider compatibility map. For `pr240`,
`maintenanceExecution.ts` calls the SDK's `restartApp`/`updateApp` with one UUIDv4
per logical command and `pollOptions: false`. The SDK owns fresh authentication
on each invocation and its structured uncertain-request diagnostics. Barney
does not automatically retry a mutation or replace its key after an error.

`maintenanceOperation.ts` scopes recovery by chain/endpoints, wallet, provider,
and lease. It persists the key, operation, exact-byte SHA-256, and original
release-version baseline before dispatch. Raw payloads and prior manifests
remain in memory. A retry uses those exact bytes without rebuilding passwords.
After reload, an original attachment can be merged with cached defaults only
as a candidate: its exact hash must match. Without an attachment, provider
release history can supply hash-matching bytes for a recovery confirmation;
that lookup does not establish command admission or completion. An attachment that does not
match falls through to retained bytes and history rather than blocking recovery within the turn. If neither
source matches, the exact reviewed payload is still required. A failed history read or rejected
signature remains retryable and does not establish that the bytes are permanently lost. A durable rejection
creates no release: if its response and a generated/edited payload are both lost,
the tenant API offers no receipt lookup to resolve the command. Barney keeps it
unresolved; deleting its metadata would not cancel Fred's command or make a new
key safe. Fred's per-lease fence prevents overlapping work, but a new key can
execute after the old command finishes and repeat the operation. If exact bytes
cannot be recovered, a user may separately confirm `stop_app` to end the lease;
this retires the record only after authoritative closure, and is termination,
not update recovery. Browser storage
failures block dispatch, but retirement after an authoritative closed lease is
best-effort and cannot change the stop result. Web Locks coordinate state
between tabs where supported; the fallback serializes only within one tab.
Missing metadata drops stale memory, and a recovery confirmation
requires the pending record to still exist. Settled confirmations are memoized
in memory so retrying a batch does not resubmit already completed items.
A compact nonsecret settled receipt replaces the pending record at the same storage
key, using less quota, and persists across tabs and reloads. It blocks ordinary planning
only when recovery advice was issued, preventing stale retry advice from becoming a new
command. Routine directly reported outcomes allow follow-up work immediately. Legacy pending
records without the advice flag conservatively retain that barrier. Deliberate
`new_command: true` planning acknowledges a blocking receipt; no flag bypasses pending work.
Every new confirmation binds the previous receipt's key so another settlement refuses dispatch.
A tab also retains a nonsecret recovery intent in sessionStorage and memory: another tab's
later successor cannot erase old advice here. Only dispatch of an explicitly confirmed new
command consumes its bound intent. Nonsecret scoped identities remain attached to completed chat rows,
so loading persisted advice restores its guard in a new tab even after a successor or sessionStorage quota failure.
Advice marking does not rewrite an already-settled receipt,
and storage-write failures preserve local recovery evidence without failing status queries.
If that intent survives but neither a pending record nor a settled receipt exists, both planning
and execution refuse a new command, including `new_command: true`; missing metadata proves no outcome.
Cancellation before dispatch writes a smaller `not_sent` receipt with any prior blocking flag. It proves
that only its matching recovery intent can be retired, including in an observing tab or restored transcript.
Advice for a newer unsent command preserves an existing guard. Transcript restoration loads
never-sent proof before selecting the oldest actionable advice, so retiring one temporary
command cannot erase an older command's still-visible guidance.
Verified provider outcomes and manifest
updates survive receipt-write failure; cached exact retries repeat local cleanup without another
POST. Replays identify the previously verified result; cancellation during cleanup leaves that verdict known.
If storage cannot be read to verify current command identity, the provider verdict remains
known but registry projection is deferred. No completed memo hides that work: restoring storage
allows status reconciliation or same-key recovery to finish the projection safely.
The session retains at most 128 completed/reserved identities without eviction.
Planning checks capacity before offering a card; confirmed batches reserve all
new entries atomically before any provider work. Unsubmitted slots are released,
while dispatched unresolved commands retain theirs until authoritative closure, even when
local storage cleanup fails. Existing pending operations
remain recoverable at capacity, but new commands require clearing chat history
to invalidate old confirmations.
Wallet changes, history clearing, and store destruction also invalidate cache
epochs so late responses cannot repopulate a previous session.
A durable Fred refusal still retires its matching pending record after abort or
session invalidation; cancellation cannot undo that authoritative receipt.

`maintenanceOutcome.ts` evaluates command outcome separately from readiness.
A 202 replay can precede execution while the source runtime is still ready.
Verification therefore requires a single new consecutive settled release from
the original baseline; a failed replacement can coexist with a healthy restored
runtime. Missing reads, unchanged history, and ambiguous generations retain the
recovery record. The Fred tenant API exposes no command key in release history,
so multiple intervening operations cannot be attributed automatically and
remain unconfirmed. Uncertain requests never authorize an automatic stop/redeploy
or a replacement command. Settled updates project their command-owned manifest
even after unrelated registry changes. Provision-state verdicts are independent
of readiness-flag refreshes. Clearing readiness staleness and changing connection
observations require their own snapshot fields to remain current; missing or unsettled
runtime status can reassert readiness staleness without retracting a verdict. Uncertain
maintenance marks connection inventory and readiness stale independently, scheduling bounded
background status reads without changing the prior provider observation (including an absent
observation). Shared foreground/background logic restores DNS evidence on a fresh connection
read while continuing readiness observation through missing or in-progress statuses. Uncertain
readiness keeps the extended eight-attempt allowance after foreground refreshes and reloads;
false and unset freshness flags compare equally when checking a registry snapshot.
Execution and reconciliation share this rule even after the command itself settles.
When a fresh provision read fails, execution retains a settled runtime verdict from its wait.

Successful batch maintenance preserves any local-cleanup warning in its result, summary and
progress. Automatic deploy diagnostics keep the provider verdict and guidance before a bounded
tail per service. Batch summaries redistribute unused diagnostic space and render compact
reason, lookup and service tails at the final budget, preserving headers and ending lines.
Internal rendering metadata is stripped from progress and tool results. Single-deploy logs
preserve line breaks, and preview processing slices the input before code-point conversion.

The confirmation UI preserves unchanged payload bytes and disables editing of
recovery payloads. Focused tests use the real SDK lifecycle and authentication
methods with simulated transport failures, alongside storage, outcome, and
provider-validation tests.

- `transactionConsent.test.tsx` exercises real model dispatch and the rendered confirmation flow: unknown/removed/raw tool names, malformed amounts and raw overrides, automatic signature approval, cancellation, uncertain submission, and duplicate confirmation.
- Existing executor/integration suites cover every retained operation, including single/bulk lifecycle actions, custom-domain attach/clear, batch deployment integrity, and account setup.
- `sdkPreflight.test.ts` calls the published SDK directly to verify domain and update-payload rejection before wallet/provider access. Deploy regressions cover callback failures, partial errors without a step, and progress observers that throw or reject.
- `transactionFees.test.ts` and `useManifestMCP.test.ts` connect the displayed fee ceiling to the wallet's configured gas limit.
- `transactionBoundary.test.ts` rejects known raw transaction APIs in runtime identifiers, private members, and string/template literals, including constants and reflective access. It covers class bases and generic function references, CosmJS signing-client entry points, and wildcard re-exports from Manifest SDK/CosmJS modules. Runtime handler-map keys are subject to the same policy as locally implemented signing methods.

The guard scans JavaScript and TypeScript sources, including JSX, TSX, MJS, CJS, MTS, and CTS. Declaration files, ambient declarations, and abstract member signatures are excluded; concrete methods and class bases of abstract classes are still checked. Type annotations, interface inheritance, and class `implements` clauses are allowed. The literal presence checks `'signDirect' in signer` and `Object.hasOwn(signer, 'signDirect')` are allowed; reading the member with `typeof signer.signDirect` is rejected.

Vitest files and the exact helper paths in `TEST_ONLY_SOURCE_FILES` are excluded. That set currently contains `ai/toolExecutor/testHelpers.ts`, a registry mock imported only by tests. Add an entry with its reason when a shared test fixture needs raw API stubs; the failure message names this constant. The guard rejects product-code imports and re-exports of excluded fixtures, including literal dynamic imports and `require` calls. Runtime exceptions need a reviewed SDK capability rather than a file exclusion.

The guard checks named source patterns. Code review still checks dynamically constructed names and signing APIs that the denylist cannot identify.
