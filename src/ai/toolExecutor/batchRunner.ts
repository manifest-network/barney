/**
 * Shared batch execution infrastructure.
 *
 * Provides signing mutex, bounded-concurrency runner, overall-phase computation,
 * and result summarization — used by executeConfirmedBatchDeploy and
 * executeConfirmedBatchRestart.
 */

import { AI_BATCH_DEPLOY_CONCURRENCY, AI_BATCH_DIAGNOSTIC_CHARS, AI_BATCH_GUIDANCE_CHARS } from '../../config/constants';
import { normalizeErrorPunctuation } from '../../utils/errors';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import type { DeployProgress } from '../progress';
import { FAILURE_DETAIL_CHARS } from './helpers';
import type { SignResult, ToolResult } from './types';
import { renderDeployDiagnostic, type DeployFailureDiagnostic } from './deployDiagnostic';
import { allocateDiagnosticBudgets } from './diagnosticBudget';

// ---------------------------------------------------------------------------
// Signing Mutex
// ---------------------------------------------------------------------------

export interface SigningMutex {
  /**
   * Mutex-wrapped signArbitrary — only the signing call is serialized,
   * not subsequent HTTP work that uses the resulting token/signature.
   * ENG-312 Phase 8: the public `withSign` escape hatch was removed (chain-TX
   * serialization is now SDK-internal); the same lock still backs this method.
   */
  signArbitraryWithMutex: (address: string, data: string) => Promise<SignResult>;
}

export function createSigningMutex(
  signArbitrary: (address: string, data: string) => Promise<SignResult>
): SigningMutex {
  let signLock: Promise<void> = Promise.resolve();

  const withSign = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = signLock;
    let unlock!: () => void;
    signLock = new Promise<void>(r => { unlock = r; });
    await prev;
    try {
      return await fn();
    } finally {
      unlock();
    }
  };

  const signArbitraryWithMutex = (addr: string, data: string) =>
    withSign(() => signArbitrary(addr, data));

  // `withSign` stays as an internal closure backing signArbitraryWithMutex, but
  // is no longer exposed publicly (ENG-312 Phase 8).
  return { signArbitraryWithMutex };
}

// ---------------------------------------------------------------------------
// Overall Phase Computation
// ---------------------------------------------------------------------------

/**
 * Compute the overall batch phase from individual entry phases.
 *
 * Terminal logic (ready/failed) is universal. For in-progress phases, callers
 * pass an ordered list of intermediate phases (highest priority first) that
 * represent their operation's pipeline.
 *
 * Example: deploy passes `['provisioning', 'uploading', 'creating_lease']`,
 * restart passes `['provisioning', 'restarting']`.
 */
export function computeOverallPhase(
  phases: DeployProgress['phase'][],
  intermediatePhases: DeployProgress['phase'][]
): DeployProgress['phase'] {
  if (phases.every((p) => p === 'ready')) return 'ready';
  if (phases.every((p) => p === 'ready' || p === 'failed')) {
    return phases.some((p) => p === 'ready') ? 'ready' : 'failed';
  }
  if (phases.every((p) => p === 'ready' || p === 'failed' || p === 'unconfirmed')) {
    return 'unconfirmed';
  }
  for (const phase of intermediatePhases) {
    if (phases.some((p) => p === phase)) return phase;
  }
  // Fallback to the last (least-advanced) intermediate phase, or 'failed' if empty
  return intermediatePhases.length > 0 ? intermediatePhases[intermediatePhases.length - 1] : 'failed';
}

// ---------------------------------------------------------------------------
// Batch Runner
// ---------------------------------------------------------------------------

export interface BatchEntry {
  name: string;
}

export interface BatchSuccessItem {
  name: string;
  url?: string;
  /** Verified provider success can still require local recovery cleanup. */
  localCleanupPending?: boolean;
  /** A cached result describes earlier work, not a new provider request. */
  replayed?: boolean;
  /** Authored guidance rendered beside the app name in the summary. */
  detail?: string;
}

/**
 * What `executeOne` returns for an entry that neither plainly succeeded nor
 * plainly failed. `null` still means failed, a bare `{ name, url? }` still means
 * succeeded, and `outcome` names the two verdicts that are neither — and that
 * must never be rounded into `succeeded`:
 *   - `'unconfirmed'` — issued, but the provider never gave a verdict.
 *   - `'cancelled'` — the user aborted, either before the provider was asked or
 *     while awaiting the result of a call that had already landed.
 */
export interface BatchResultItem extends BatchSuccessItem {
  outcome?: 'unconfirmed' | 'cancelled';
}

export interface BatchRunnerOptions<E extends BatchEntry> {
  entries: E[];
  /** Ordered intermediate phases, highest priority first (e.g. ['provisioning', 'uploading', 'creating_lease']). */
  intermediatePhases: DeployProgress['phase'][];
  /** Initial phase for all entries (e.g. 'creating_lease', 'restarting'). */
  initialPhase: DeployProgress['phase'];
  /** Optional operation tag forwarded on every onProgress call. */
  operation?: DeployProgress['operation'];
  /** Concurrency limit. Defaults to AI_BATCH_DEPLOY_CONCURRENCY. */
  concurrency?: number;
  /** Abort signal — checked before queuing new tasks, not inside executeOne. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (progress: DeployProgress) => void;
  /**
   * Per-entry execution function.
   *
   * Must call `updateProgress(phase, detail)` to report per-app progress.
   * On success, return `{ name, url? }`.
   * On failure, call `updateProgress('failed', detail)` BEFORE returning `null`.
   * The runner records failed entries by name — the failure detail comes from
   * the updateProgress call, not from the return value.
   * For the two in-between verdicts, return `{ name, outcome, detail? }` — see
   * `BatchResultItem`.
   */
  executeOne: (
    entry: E,
    index: number,
    updateProgress: (phase: DeployProgress['phase'], detail?: string, diagnostic?: DeployFailureDiagnostic) => void,
  ) => Promise<BatchResultItem | null>;
}

export interface BatchRunResult {
  succeeded: BatchSuccessItem[];
  failed: string[];
  /** Issued, but the provider never confirmed the outcome — neither succeeded nor failed. */
  unconfirmed: BatchResultItem[];
  /** Aborted by the user rather than failed: never queued (the signal aborted before its turn), or `executeOne` said so. */
  cancelled: string[];
  batchProgress: Array<{ name: string; phase: DeployProgress['phase']; detail?: string; diagnostic?: DeployFailureDiagnostic }>;
}

function sanitizeDiagnostic(detail: string | undefined): string | undefined {
  // These strings include Barney's next steps, after provider fields have been
  // bounded at their source. A provider-field cap would cut off that guidance.
  return detail === undefined ? undefined : sanitizeForDisplay(detail, AI_BATCH_GUIDANCE_CHARS);
}

function sanitizeProgressDetail(phase: DeployProgress['phase'], detail: string | undefined): string | undefined {
  return phase === 'failed' || phase === 'unconfirmed' || phase === 'ready' ? sanitizeDiagnostic(detail) : detail;
}

/** Fit an allocated JSON budget, including quotes, escapes and surrogate pairs. */
function fitDiagnostic(detail: string | undefined, budget: number, diagnostic?: DeployFailureDiagnostic): string | undefined {
  const clean = sanitizeDiagnostic(detail);
  if (clean === undefined || budget < 3) return undefined;
  if (JSON.stringify(clean).length <= budget) return clean;
  if (diagnostic) return renderDeployDiagnostic(diagnostic, budget, true);
  let result = '';
  let length = 3; // JSON quotes and the final ellipsis.
  for (const point of clean) {
    const size = JSON.stringify(point).length - 2;
    if (length + size > budget) break;
    result += point;
    length += size;
  }
  return `${result}…`;
}

export async function runBatchWithConcurrency<E extends BatchEntry>(
  opts: BatchRunnerOptions<E>,
): Promise<BatchRunResult> {
  const {
    entries,
    intermediatePhases,
    initialPhase,
    operation,
    signal,
    onProgress,
    concurrency = AI_BATCH_DEPLOY_CONCURRENCY,
    executeOne,
  } = opts;

  const batchProgress: BatchRunResult['batchProgress'] =
    entries.map((e) => ({ name: e.name, phase: initialPhase, detail: 'Waiting...' }));

  const emitProgress = () => {
    const overallPhase = computeOverallPhase(
      batchProgress.map((b) => b.phase),
      intermediatePhases
    );
    onProgress?.({
      phase: overallPhase,
      ...(operation ? { operation } : {}),
      batch: batchProgress.map(({ name, phase, detail }) => ({ name, phase, detail })),
    });
  };

  emitProgress();

  const succeeded: BatchSuccessItem[] = [];
  const failed: string[] = [];
  const unconfirmed: BatchResultItem[] = [];
  // Seeded by `executeOne` verdicts; the un-queued tail is appended after the loop.
  const cancelled: string[] = [];

  // Run with bounded concurrency — check abort before queuing, not inside executeOne.
  // Already-queued tasks run to completion (they may have broadcast a TX).
  // `queuedCount` tracks how many entries actually got queued; anything at a
  // higher index was never started (abort short-circuited the loop) and must be
  // reported as cancelled rather than left stuck at its 'Waiting...' initial row.
  const active = new Set<Promise<void>>();
  let queuedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) break;
    queuedCount = i + 1;

    const updateProgress = (phase: DeployProgress['phase'], detail?: string, diagnostic?: DeployFailureDiagnostic) => {
      batchProgress[i] = { name: entries[i].name, phase, detail: sanitizeProgressDetail(phase, detail), ...(diagnostic && { diagnostic }) };
      emitProgress();
    };

    const p = (async () => {
      try {
        const result = await executeOne(entries[i], i, updateProgress);
        if (!result) {
          failed.push(entries[i].name);
        } else if (result.outcome === 'unconfirmed') {
          unconfirmed.push({ ...result, detail: sanitizeDiagnostic(result.detail) });
          if (operation === 'restart' || operation === 'update') {
            updateProgress('unconfirmed', result.detail ?? batchProgress[i].detail ?? 'Outcome unknown');
          }
        } else if (result.outcome === 'cancelled') {
          cancelled.push(result.name);
          const detail = result.detail ?? (batchProgress[i].phase === 'failed' ? batchProgress[i].detail : undefined);
          updateProgress('failed', detail ?? 'Cancelled');
        } else {
          succeeded.push({ ...result, ...(result.detail !== undefined && { detail: sanitizeDiagnostic(result.detail) }) });
          if (result.localCleanupPending || result.replayed) updateProgress('ready', result.detail
            ?? (result.localCleanupPending ? 'Local cleanup remains pending' : 'Previous result recovered; no new request sent'));
        }
      } catch (error) {
        // Safety net — executeOne should handle its own errors, but if it
        // throws without calling updateProgress('failed', ...), catch here.
        batchProgress[i] = {
          name: entries[i].name,
          phase: 'failed',
          detail: sanitizeForDisplay(error instanceof Error ? error.message : 'Unknown error', FAILURE_DETAIL_CHARS),
        };
        emitProgress();
        failed.push(entries[i].name);
      }
    })().finally(() => active.delete(p));

    active.add(p);
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);

  // Entries beyond queuedCount were never queued (abort short-circuited the
  // loop). Bucket them as cancelled so the summary counts every entry instead
  // of silently dropping the un-queued tail (and reporting a misleading empty
  // SUCCESS on an abort-before-any-queue).
  for (let j = queuedCount; j < entries.length; j++) {
    cancelled.push(entries[j].name);
    batchProgress[j] = { name: entries[j].name, phase: 'failed', detail: 'Cancelled (batch aborted)' };
  }
  if (queuedCount < entries.length) emitProgress();

  return { succeeded, failed, unconfirmed, cancelled, batchProgress };
}

// ---------------------------------------------------------------------------
// Result Summarization
// ---------------------------------------------------------------------------

export interface BatchSummaryOptions {
  succeeded: BatchSuccessItem[];
  failed: string[];
  /** Entries the provider never gave a verdict on — reported separately, never as succeeded. */
  unconfirmed?: BatchResultItem[];
  /** Heading for the unconfirmed block, e.g. 'Still deploying'. */
  unconfirmedLabel?: string;
  /** Entries the user aborted (never queued, cancelled before the call, or cancelled while awaiting its result). */
  cancelled?: string[];
  /** Key name for the succeeded array in the result data (e.g. 'deployed', 'restarted'). */
  dataKey: string;
  /** Past-tense verb for messages (e.g. 'Deployed', 'Restarted'). */
  verb: string;
  /** Noun for the "all failed" error (e.g. 'deploys', 'restarts'). */
  failedNoun: string;
  /** Batch progress for the final progress emission. */
  batchProgress?: BatchRunResult['batchProgress'];
  /** Optional operation for the final progress emission. */
  operation?: DeployProgress['operation'];
  /** Progress callback for the final emission. */
  onProgress?: (progress: DeployProgress) => void;
}

export function summarizeBatchResult(opts: BatchSummaryOptions): ToolResult {
  const {
    succeeded: rawSucceeded, failed, cancelled = [], unconfirmed: rawUnconfirmed = [], unconfirmedLabel = 'Still pending',
    dataKey, verb, failedNoun, batchProgress, operation, onProgress,
  } = opts;

  // Single predicate behind BOTH the overall progress phase and the failure
  // branch below, so the ProgressCard and the chat text can never disagree.
  // An unconfirmed batch has not landed, but it is not a failed batch either.
  const nothingLanded = rawSucceeded.length === 0 && rawUnconfirmed.length === 0;
  // Rows disappear when the next tool starts. Preserve the failure reason in
  // the tool result so both the user and model can act on it afterwards.
  const failureRows = new Map(batchProgress?.filter((row) => row.phase === 'failed').map((row) => [row.name, row]));
  // Failed reasons appear once in message/error. Unconfirmed reasons and local
  // cleanup warnings have both a structured field and a message copy.
  const detailedUnconfirmed = rawUnconfirmed.filter((entry) => entry.detail !== undefined).length;
  const detailedSucceeded = rawSucceeded.filter((entry) => entry.detail !== undefined).length;
  const cleanupPending = rawSucceeded.filter((entry) => entry.localCleanupPending).length;
  const replayed = rawSucceeded.filter((entry) => entry.replayed).length;
  const inputs = [
    ...failed.map((name) => ({ detail: failureRows.get(name)?.detail, copies: 1 })),
    ...rawUnconfirmed.map((entry) => ({ detail: entry.detail, copies: 2 })),
    ...rawSucceeded.map((entry) => ({ detail: entry.detail, copies: 2 })),
  ];
  const demands = inputs.map(({ detail, copies }) => ({
    size: detail === undefined ? 0 : JSON.stringify(sanitizeDiagnostic(detail)).length, copies,
  }));
  // Include structured detail/flag fields and two-space indentation as well as
  // text copies. Short entries return their unused share to longer diagnostics.
  let textBudget = Math.max(0, AI_BATCH_DIAGNOSTIC_CHARS - 20 * detailedUnconfirmed - 90 * detailedSucceeded);
  const shortened = demands.reduce((total, entry) => total + entry.size * entry.copies, 0) > textBudget;
  // Large batches may need shortened per-app details. Reserve one complete
  // next step rather than leaving the model with only partial instructions.
  const sharedNextSteps = [
    cleanupPending > 0 ? 'Provider outcomes were verified, but local cleanup remains pending. Restore browser storage access, then check app_status or retry the same confirmation; do not start a new command for recovery.' : '',
    failed.length > 0 ? 'Check app_status and app_diagnostics for each failed app.' : '',
    failed.some((name) => failureRows.get(name)?.diagnostic?.logs.length)
      ? 'Use get_logs(app_name, tail=200) for full logs from each failed service.' : '',
    rawUnconfirmed.length === 0 ? '' : operation === 'restart' || operation === 'update'
      ? 'Check app_status and app_releases for each unknown outcome. Recover only a command still pending, using its original key and exact payload. Do not use new_command for recovery. Do not submit a new command or automatically stop/redeploy while its outcome is unresolved.'
      : 'Check app_status for each still-deploying app. Only use stop_app if you have decided to abandon that deployment.',
  ].filter(Boolean).join(' ');
  const summaryGuidance = shortened ? `Details were shortened. ${sharedNextSteps}` : undefined;
  if (summaryGuidance) {
    // JSON quotes account for the two escaped characters of the added newline.
    textBudget = Math.max(0, textBudget - JSON.stringify(summaryGuidance).length);
  }
  const budgets = allocateDiagnosticBudgets(demands, textBudget);
  const unconfirmed = rawUnconfirmed.map((entry, index) => ({ ...entry,
    detail: fitDiagnostic(entry.detail, budgets[failed.length + index]),
  }));
  const succeeded = rawSucceeded.map((entry, index) => ({ ...entry,
    ...(entry.detail !== undefined && { detail: fitDiagnostic(entry.detail, budgets[failed.length + rawUnconfirmed.length + index]) }),
  }));
  const failedText = failed.map((name, index) => {
    const row = failureRows.get(name);
    const detail = fitDiagnostic(row?.detail, budgets[index], row?.diagnostic);
    return detail ? `${name}: ${detail}` : name;
  }).join(', ');

  // Maintenance has a neutral terminal phase: no verified restart/update may
  // be reported as complete just because the runner finished waiting. Deploy
  // retains its existing summary contract.
  const maintenanceUnconfirmed = (operation === 'restart' || operation === 'update') && unconfirmed.length > 0;
  if (onProgress) {
    // Every segment is conditional, so zero counts are never printed.
    const segments = [
      succeeded.length > replayed ? `${succeeded.length - replayed} ${verb.toLowerCase()}` : '',
      replayed > 0 ? `${replayed} previous ${replayed === 1 ? 'result' : 'results'} recovered` : '',
      cleanupPending > 0 ? `${cleanupPending} local cleanup pending` : '',
      failed.length > 0 ? `${failed.length} failed` : '',
      unconfirmed.length > 0 ? `${unconfirmed.length} ${unconfirmedLabel.toLowerCase()}` : '',
      cancelled.length > 0 ? `${cancelled.length} cancelled` : '',
    ].filter(Boolean);
    const allSucceeded = segments.length === 1 && succeeded.length > 0 && replayed === 0;
    onProgress({
      phase: maintenanceUnconfirmed ? 'unconfirmed' : nothingLanded ? 'failed' : 'ready',
      ...(operation ? { operation } : {}),
      // No segments at all means an empty batch — never emit '' or 'All 0 apps'.
      detail: segments.length === 0
        ? `No apps ${verb.toLowerCase()}`
        : allSucceeded
          ? `All ${succeeded.length} ${succeeded.length === 1 ? 'app' : 'apps'} ${verb.toLowerCase()}!`
          : segments.join(', '),
      ...(batchProgress ? { batch: batchProgress.map(({ name, phase, detail }) => ({ name, phase, detail: sanitizeProgressDetail(phase, detail) })) } : {}),
    });
  }

  if (nothingLanded) {
    // Nothing landed. When there were no cancellations this is a pure all-failed
    // batch — keep the original message (test/UX contract). Otherwise name both
    // buckets so the abort isn't hidden behind a bare "all failed".
    if (cancelled.length === 0) {
      return { success: false, error: `All ${failedNoun} failed: ${failedText}${summaryGuidance ? `\n${summaryGuidance}` : ''}` };
    }
    const failedPart = failed.length > 0 ? `Failed: ${normalizeErrorPunctuation(failedText)}.` : '';
    const cancelledPart = `Cancelled: ${cancelled.join(', ')}.`;
    return {
      success: false,
      error: `No ${failedNoun} completed — ${[failedPart, cancelledPart].filter(Boolean).join(' ')}${summaryGuidance ? `\n${summaryGuidance}` : ''}`,
    };
  }

  const parts: string[] = [];
  if (succeeded.length > 0) {
    const lines = succeeded.map((d) => `${d.url ? `${d.name}: ${d.url}` : d.name}${d.detail ? ` — ${d.detail}` : ''}`);
    parts.push(`${verb}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  if (unconfirmed.length > 0) {
    const lines = unconfirmed.map((u) => u.detail ? `${u.name}: ${u.detail}` : u.name);
    parts.push(`${unconfirmedLabel}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  if (failed.length > 0) parts.push(`Failed: ${normalizeErrorPunctuation(failedText)}.`);
  if (cancelled.length > 0) parts.push(`Cancelled: ${cancelled.join(', ')}.`);
  if (summaryGuidance) parts.push(summaryGuidance);

  return {
    success: true,
    data: {
      [dataKey]: succeeded,
      failed,
      unconfirmed,
      cancelled,
      message: parts.join('\n'),
    },
  };
}
