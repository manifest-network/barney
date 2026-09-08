# SDK transaction boundary

Barney plans and previews product actions, obtains user confirmation, then calls typed Manifest SDK operations. The model cannot select arbitrary chain messages, transaction commands, recipients for credit funding, or fee overrides. Unsupported transfers, staking, governance, and credit withdrawals remain unavailable until a reviewed high-level SDK capability and purpose-built Barney tool exist.

## Transaction inventory (ENG-830)

Reviewed against the pinned `@manifest-network/manifest-sdk` 0.21.0. There are no direct `cosmosTx`, `executeTx`, signing-client, or low-level broadcast calls in Barney product code. `src/build/transactionBoundary.test.ts` guards this boundary.

| Product action / caller | SDK operation | Approval data | Fee and cancellation policy |
| --- | --- | --- | --- |
| Single and batch deploy (`compositeTransactions.ts`) | `deployManifest` | App, tier/provider, manifest, optional service/domain; batch also binds prices and hashes | Up to two chain transactions per app; `abortSignal` reaches the SDK |
| Single and bulk stop (`compositeTransactions.ts`, sidebar request in `stopApp.ts`) | `stopApp` | Explicit app names and lease IDs resolved before approval | At most one transaction per app; `signal`; bulk uses CheckTx and reconciles later |
| Chat credit funding (`compositeTransactions.ts`) | `fundCredits` | Positive PWR amount and bound wallet address | One transaction; `signal`; no tenant or fee override |
| First-connect account setup (`useAccountSetup.ts`) | `fundCredits` | Fixed application-policy amount, SDK defaults recipient to signer | One transaction per attempt; setup `signal` on initial call and retry; automatic faucet-enabled onboarding, outside chat consent |
| Restart (`compositeTransactions.ts`) | `restartApp` | App names, lease IDs, provider URLs | Provider-only operation; `signal` |
| Update (`compositeTransactions.ts`) | `updateApp` | App, lease/provider, final manifest | Provider-only operation; `signal`; existing indeterminate-update/rollback handling retained |
| Attach/change/clear domain (`compositeTransactions.ts`) | `setItemCustomDomain` | App/lease, service, previous and requested domain | One transaction; `signal` |
| Provider/relay authentication (`useManifestMCP.ts`) | `createProviderAuth` / wallet ADR-036 proof | Wallet-bound off-chain authentication | No chain transaction or network fee |
| `src/api/tx.ts` | None | Shared types and enum re-export | No signer or broadcast implementation |

The last direct product billing call, chat credit funding, now uses `fundCredits`. Lifecycle migration prerequisites are already delivered: [ENG-494](https://linear.app/liftedinit/issue/ENG-494) supplies asynchronous stop, and [ENG-488](https://linear.app/liftedinit/issue/ENG-488) supplies cached-provider restart/update. Every retained action has an SDK operation; no missing-operation issue or raw fallback is needed. Future missing capabilities require a narrowly scoped SDK issue before exposing a new Barney action.

## Planning and execution

`transactionPlans.ts` defines strict typed semantic schemas. `transactionConfirmation` parses and freezes each plan for display, and the confirmed executor parses that same schema again before any SDK mutation. The sidebar's direct stop action uses the same helper. Batch deploy retains its canonical planner and confirmation-time hash, catalog, and aggregate-balance checks. Intermediate model batch drafts are not directly confirmable. Failed batch-edit feedback is removed from the arguments before dispatch, so reverting edits can confirm the original plan without weakening the schema.

Credit funding retains only the PWR display amount and wallet address. Both phases reject non-positive, non-finite, excessive-precision, and unsafe-base-unit amounts. Confirmation derives the SDK coin string with decimal-safe conversion, verifies the wallet binding, and omits `tenant` so the SDK funds the signer. SDK cancellation retains the distinction between not submitted and possibly submitted; uncertain transfers require a balance check before retrying.

The wallet manager receives `MAX_TRANSACTION_GAS = 50_000_000`. SDK simulation rejects estimates above that ceiling before signing. At the configured `GAS_PRICE`, `transactionFees.ts` calculates the maximum fee shown by `ConfirmationCard`, including batch totals and optional deploy domain transactions. Invalid fee configuration displays an inline error and disables confirmation while preserving cancellation. No tool can override the gas ceiling, gas price, or explicit fee. SDK methods retain typed result/error contracts; Barney maps them into chat results while preserving existing lifecycle uncertainty handling.

Web3Auth's `promptSign` automatically accepts SDK signature requests. It is not a human approval boundary. Chat approval is consumed once in `confirmAction`, with wallet/chain/client/signer generation checks and cancellation before dispatch and each SDK mutation. Account setup and off-chain authentication follow the separate policies in [security](security.md#5-transaction-confirmation).

## Regression coverage

- `transactionConsent.test.tsx` exercises real model dispatch and the rendered confirmation flow: unknown/removed/raw tool names, malformed amounts and raw overrides, automatic signature approval, cancellation, uncertain submission, and duplicate confirmation.
- Existing executor/integration suites cover every retained operation, including single/bulk lifecycle actions, custom-domain attach/clear, batch deployment integrity, and account setup.
- `transactionFees.test.ts` and `useManifestMCP.test.ts` connect the displayed fee ceiling to the wallet's configured gas limit.
- `transactionBoundary.test.ts` prevents direct low-level transaction imports or signing/broadcast access from returning to product code.
