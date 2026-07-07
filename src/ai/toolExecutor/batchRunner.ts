/**
 * Shared batch execution infrastructure.
 *
 * Provides signing mutex, bounded-concurrency runner, overall-phase computation,
 * and result summarization — used by executeConfirmedBatchDeploy and
 * executeConfirmedBatchRestart.
 */

import { AI_BATCH_DEPLOY_CONCURRENCY } from '../../config/constants';
import type { DeployProgress } from '../progress';
import type { SignResult, ToolResult } from './types';

// ---------------------------------------------------------------------------
// Signing Mutex
// ---------------------------------------------------------------------------

export interface SigningMutex {
  /** Serialize any async wallet operation (cosmosTx, signArbitrary). */
  withSign: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Mutex-wrapped signArbitrary — only the signing call is serialized,
   * not subsequent HTTP work that uses the resulting token/signature.
   *
   * `withSign` and `signArbitraryWithMutex` share the same lock.
   * Do NOT call one while holding the other (would deadlock).
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

  return { withSign, signArbitraryWithMutex };
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
   */
  executeOne: (
    entry: E,
    index: number,
    updateProgress: (phase: DeployProgress['phase'], detail?: string) => void,
  ) => Promise<BatchSuccessItem | null>;
}

export interface BatchRunResult {
  succeeded: BatchSuccessItem[];
  failed: string[];
  batchProgress: Array<{ name: string; phase: DeployProgress['phase']; detail?: string }>;
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

  const batchProgress: Array<{ name: string; phase: DeployProgress['phase']; detail?: string }> =
    entries.map((e) => ({ name: e.name, phase: initialPhase, detail: 'Waiting...' }));

  const emitProgress = () => {
    const overallPhase = computeOverallPhase(
      batchProgress.map((b) => b.phase),
      intermediatePhases
    );
    onProgress?.({
      phase: overallPhase,
      ...(operation ? { operation } : {}),
      batch: batchProgress.map((b) => ({ ...b })),
    });
  };

  emitProgress();

  const succeeded: BatchSuccessItem[] = [];
  const failed: string[] = [];

  // Run with bounded concurrency — check abort before queuing, not inside executeOne.
  // Already-queued tasks run to completion (they may have broadcast a TX).
  const active = new Set<Promise<void>>();
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) break;

    const updateProgress = (phase: DeployProgress['phase'], detail?: string) => {
      batchProgress[i] = { name: entries[i].name, phase, detail };
      emitProgress();
    };

    const p = (async () => {
      try {
        const result = await executeOne(entries[i], i, updateProgress);
        if (result) {
          succeeded.push(result);
        } else {
          failed.push(entries[i].name);
        }
      } catch (error) {
        // Safety net — executeOne should handle its own errors, but if it
        // throws without calling updateProgress('failed', ...), catch here.
        batchProgress[i] = {
          name: entries[i].name,
          phase: 'failed',
          detail: error instanceof Error ? error.message : 'Unknown error',
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

  return { succeeded, failed, batchProgress };
}

// ---------------------------------------------------------------------------
// Result Summarization
// ---------------------------------------------------------------------------

export interface BatchSummaryOptions {
  succeeded: BatchSuccessItem[];
  failed: string[];
  /** Key name for the succeeded array in the result data (e.g. 'deployed', 'restarted'). */
  dataKey: string;
  /** Past-tense verb for messages (e.g. 'Deployed', 'Restarted'). */
  verb: string;
  /** Noun for the "all failed" error (e.g. 'deploys', 'restarts'). */
  failedNoun: string;
  /** Batch progress for the final progress emission. */
  batchProgress?: Array<{ name: string; phase: DeployProgress['phase']; detail?: string }>;
  /** Optional operation for the final progress emission. */
  operation?: DeployProgress['operation'];
  /** Progress callback for the final emission. */
  onProgress?: (progress: DeployProgress) => void;
}

export function summarizeBatchResult(opts: BatchSummaryOptions): ToolResult {
  const { succeeded, failed, dataKey, verb, failedNoun, batchProgress, operation, onProgress } = opts;

  // Emit final progress
  if (onProgress) {
    onProgress({
      phase: failed.length === 0 ? 'ready' : succeeded.length > 0 ? 'ready' : 'failed',
      ...(operation ? { operation } : {}),
      detail: failed.length === 0
        ? `All ${succeeded.length} ${succeeded.length === 1 ? 'app' : 'apps'} ${verb.toLowerCase()}!`
        : `${succeeded.length} ${verb.toLowerCase()}, ${failed.length} failed`,
      ...(batchProgress ? { batch: batchProgress.map((b) => ({ ...b })) } : {}),
    });
  }

  if (failed.length > 0 && succeeded.length === 0) {
    return { success: false, error: `All ${failedNoun} failed: ${failed.join(', ')}` };
  }

  const parts: string[] = [];
  if (succeeded.length > 0) {
    const lines = succeeded.map((d) => d.url ? `${d.name}: ${d.url}` : d.name);
    parts.push(`${verb}:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  if (failed.length > 0) parts.push(`Failed: ${failed.join(', ')}.`);

  return {
    success: true,
    data: {
      [dataKey]: succeeded,
      failed,
      message: parts.join('\n'),
    },
  };
}
