# ENG-976 boundary acceptance review

This review follows the complete failure/recovery path rather than individual
PR comments: SDK/provider response → tool result → chat/model → stored history
→ reload → recovery. The starting revision is `af64ae5` on PR #134, targeting
Fred `f42a639a8e3bbc5bd2c9e2faa525bfff54b8b72c` with SDK 0.23.0.

## Scope and stopping criteria

The implementation gate is satisfied when every criterion below has traced
implementation evidence and regression coverage, every verified correctness or
recovery finding is fixed, independent review has no remaining blockers, and
the full validation suite plus CI pass on the resulting commit. Cosmetic
changes and unrelated existing behavior are recorded separately; they do not
restart the review. New evidence of a correctness or recovery failure reopens
the relevant criterion.

| ID | Acceptance criterion | Evidence / result |
| --- | --- | --- |
| A1 | A logical restart/update retains one UUIDv4 and exact payload through retry, conflict, cancellation and lost responses; batch items have independent identities and completed items are not resubmitted. | Passed code review: [maintenanceExecution.test.ts](../../../src/ai/toolExecutor/maintenanceExecution.test.ts) covers exact key/body recovery and independent batch replay; [manifestConfirmation.test.ts](../../../src/ai/toolExecutor/manifestConfirmation.test.ts) covers file/image/stack recovery after reload. |
| A2 | SDK fresh authentication and recovery classifications drive recovery. Uncertain submission never implies nothing happened or makes a new command safe. | Passed code review: real SDK tests cover lost response, 409, 503, 500, cancellation and fresh retry authentication. [maintenancePlanning.test.ts](../../../src/ai/toolExecutor/maintenancePlanning.test.ts) checks pending-command precedence over `new_command`. |
| A3 | Operation outcome and runtime readiness remain independent, including a failed replacement whose previous runtime is healthy. | Passed code review: [maintenanceOutcome.test.ts](../../../src/ai/toolExecutor/maintenanceOutcome.test.ts), [maintenanceExecution.test.ts](../../../src/ai/toolExecutor/maintenanceExecution.test.ts) and [maintenanceReconciliation.test.ts](../../../src/ai/toolExecutor/maintenanceReconciliation.test.ts) cover compensated failure, old healthy releases, missing observations and read-only settlement. |
| A4 | External error prose and named failure fields are bounded at their display/model boundary without changing classification or cutting authored recovery instructions. Successful requested logs keep their content. | Accepted B2 fixes independently reviewed. [transactionErrorBoundary.test.ts](../../../src/ai/toolExecutor/transactionErrorBoundary.test.ts) covers real SDK rejection, cancellation, success and manifest builders; [queryErrorBoundary.test.ts](../../../src/ai/toolExecutor/queryErrorBoundary.test.ts) covers response bodies and structured failure fields. |
| A5 | UI suggestions and model-facing results preserve the observed outcome and direct unresolved maintenance toward observation or exact recovery. | B1/B3 fixes independently reviewed. [MessageBubble.test.tsx](../../../src/components/ai/MessageBubble.test.tsx), [maintenanceRecoveryBoundary.test.tsx](../../../src/ai/toolExecutor/maintenanceRecoveryBoundary.test.tsx) and [utils.test.ts](../../../src/stores/aiActions/utils.test.ts) cover live/reloaded actions, real SDK mixed outcomes and actual relay wire projection. |
| A6 | Retained source rows preserve recovery metadata through save/load, truncation, legacy formats and wallet/tab changes; durable pending commands remain guarded independently of transcript retention. Formatting changes cannot authorize a replacement command. | Passed code review and 208 focused persistence/store tests. [persistedErrors.test.tsx](../../../src/stores/aiActions/persistedErrors.test.tsx) covers marked/legacy errors and an 80-app alert; [maintenanceAdvicePersistence.test.ts](../../../src/stores/aiActions/maintenanceAdvicePersistence.test.ts) and [persistence.integration.test.ts](../../../src/stores/aiActions/persistence.integration.test.ts) cover source correlation and identity changes. |

Coverage uses representative composed paths for each boundary and the existing
focused invariant suites. A green test count alone is not the acceptance
argument. Failure fixtures include returned and thrown errors, single and
batch operations, partial success, indeterminate outcomes, compensation,
legacy rows, oversized rows and failed storage writes.

## Findings and disposition

### B1: maintenance recovery offered an unrelated deployment (A5)

`MessageBubble` matched the words `payload` or `signature` before considering
which operation produced the error. An uncertain restart/update could therefore
offer **Deploy an app** or **Try again**, sending `Deploy an app` to the model.
Four live/reloaded restart/update regressions failed against the audit baseline.

Maintenance error rows and other error rows carrying recovery advice now offer a read-only
status/releases check before generic keyword suggestions. Focused rendering
coverage checks both tool identity and attached source advice. The composed
[maintenanceRecoveryBoundary.test.tsx](../../../src/ai/toolExecutor/maintenanceRecoveryBoundary.test.tsx) follows actual SDK results through the
confirmed-result message shape, save/load, model projection and rendered action.

### B2: returned errors bypassed the exception boundary (A4)

The inventory checked returned values as well as throws. Single stop, credit
funding and custom-domain errors, chain `rawLog`, and manifest-builder exceptions
could return unbounded unsanitized text. A real SDK dispatch probe retained a
2,020-character body with newline, NUL and bidi controls. Release/history failure
fields and diagnostic status also bypassed the query catch-all because their
requests succeeded.

Fixes are limited to display/model projections. Raw values remain available for
classification and release reconciliation. Cancellation safety instructions must
survive any shortening: a known never-sent cancellation stays distinct from a
possibly submitted transaction. The SDK boundary regressions cover sent, never-sent
and unknown-submission cancellation, plus successful controls.

The input inventory traced all query catches, four executor catch-alls, returned
transaction errors, SDK manifest builders, deploy diagnostic rendering, legacy
and pr240 maintenance, batch catch/summary paths, and named failure fields in
successful query results. Newly bounded error details use the existing 256-code-point cap;
release reasons use 64, diagnostic status uses its existing 64-code-point display
cap, and curated durable Fred refusals retain their existing 512-code-point cap.
Manifest/preparation diagnostics retain their established separate budgets. The
new boundary tests also check successful operations and full logs.

### B3: history replay emitted unmatched tool responses (A5/A6)

History deliberately discards executable assistant tool calls while retaining
result text. The model projection still emitted interior historical results as
`role: tool` with their old call IDs. Neither relay compaction nor serialization
repaired the missing call; a strict compatible backend can reject the recovery
request after reload.

The bounded fix projects interior unmatched historical results as labeled ordinary
assistant context with their exact result text. Leading orphan results are still
discarded. It does not restore or invent calls and leaves valid live tool exchanges
unchanged. A composed regression
checks save/load → model projection → relay compaction → wire serialization,
including the user's read-only recovery request and the complete recovery
prohibition.

## Nonblocking limitations and follow-ups

- Clients running an older build retain that build's history validation and
  formatting. Refreshing those clients is required to use the current saved
  diagnostics format. This audit does not add a history migration that modifies
  already-running older clients.
- Recovery advice is correlated to retained source rows, not arbitrary model
  paraphrases. Chat load retains the latest 100 candidate rows; default in-memory
  retention is 200. Removing an old settled source can remove its per-row intent
  history. A still-pending command remains guarded by its separate durable record.
- Transient progress labels can display provider phase text without the error
  detail cap. This is a separate display-hardening follow-up; it does not classify
  an operation, replace a command key or change persisted recovery guidance.
- Explicitly requested logs and non-failure inventory/history fields retain their
  existing contracts. This audit does not add pagination or an aggregate response
  budget to those APIs. It bounds failure details and batch diagnostic summaries.
- Cosmetic punctuation/layout differences which preserve the outcome and complete
  safe next step do not block deployment; no further cosmetic patch is required
  by this review.

## Deployment gate

Read-only preflights repeated on **2026-09-24** for both restart and update
returned HTTP 200 and `Access-Control-Allow-Headers:
Content-Type,Authorization,Accept`, still omitting `Idempotency-Key`. The Barney
dev origin received its expected allow-origin header; an unlisted origin received
none. Only OPTIONS requests were sent, using a placeholder lease UUID.

The dev browser rollout gate therefore remains **not satisfied**. Implementation
acceptance does not certify the deployed browser path. Before rollout, the operator
must verify dev's CORS allowance for `Idempotency-Key` and
exercise restart/update, lost-response recovery and compensated failure with a
disposable workload, recording both command outcome and runtime readiness in
[ENG-976](https://linear.app/liftedinit/issue/ENG-976).

See [the deployment procedure](../../dev/deployment.md#fred-compatibility-eng-976).
This audit does not authorize deployment, create credentials or add restore.

## Validation

Local validation on 2026-09-24 passed:

- `npm run lint` (three existing warnings in generated coverage files).
- `npm run build` (TypeScript project build and production bundle).
- `npm run check:bundle`.
- `npm test -- --maxWorkers=2`: **3,670 tests across 139 files**.
- `git diff --check`.

Independent review of the operation/recovery path, persistence/model projection
and diagnostic boundaries found no remaining implementation blockers after B1–B3.
The audit regressions reproduced four incorrect UI suggestions and two invalid
history-protocol cases before their fixes. Real SDK boundary and composed recovery
tests cover the corrected behavior.

The resulting commit and its exact-head CI result are recorded on
[PR #134](https://github.com/manifest-network/barney/pull/134) and
[ENG-976](https://linear.app/liftedinit/issue/ENG-976). Rollout still requires the
separate deployment gate above.
