import { describe, expect, it, vi } from 'vitest';
import { AI_BATCH_DIAGNOSTIC_CHARS, AI_BATCH_GUIDANCE_CHARS } from '../../config/constants';
import { FAILURE_DETAIL_CHARS } from './helpers';
import { computeOverallPhase, runBatchWithConcurrency, summarizeBatchResult } from './batchRunner';

describe('maintenance batch uncertainty', () => {
  it.each([false, true])('distinguishes cached results from new successful commands (mixed: %s)', async (mixed) => {
    const detail = 'Previous restart succeeded. This confirmation recovered that earlier result; no new request was sent.';
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'cached' }, ...(mixed ? [{ name: 'fresh' }] : [])],
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart', onProgress,
      executeOne: async ({ name }, _index, progress) => {
        if (name === 'cached') return { name, replayed: true, detail };
        progress('ready');
        return { name };
      },
    });
    const result = summarizeBatchResult({ ...batch, operation: 'restart', onProgress,
      dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' });
    expect(result.data).toMatchObject({ restarted: expect.arrayContaining([{ name: 'cached', replayed: true, detail }]),
      message: expect.stringContaining(detail) });
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready',
      detail: mixed ? '1 restarted, 1 previous result recovered' : '1 previous result recovered',
      batch: expect.arrayContaining([{ name: 'cached', phase: 'ready', detail }]),
    }));
  });

  it.each([1, 4, 128])('keeps cleanup warnings on %i verified successes within the serialized diagnostic budget', async (count) => {
    const detail = 'The provider outcome was verified, but its local recovery record could not be retired. Restore browser storage access and retry the same confirmation to finish local cleanup.';
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: Array.from({ length: count }, (_, index) => ({ name: `app-${index}` })),
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart', onProgress,
      executeOne: async ({ name }) => ({ name, localCleanupPending: true, detail }),
    });
    const options = { ...batch, operation: 'restart' as const, onProgress, dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' };
    const result = summarizeBatchResult(options);
    expect(result.success).toBe(true);
    expect(batch.batchProgress.every((row) => row.phase === 'ready' && row.detail === detail)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready', detail: `${count} restarted, ${count} local cleanup pending` }));
    expect(JSON.stringify(result)).not.toContain(`All ${count}`);
    const data = result.data as { restarted: Array<{ localCleanupPending?: boolean; detail?: string }>; message: string };
    expect(data.restarted.every((entry) => entry.localCleanupPending)).toBe(true);
    if (count < 128) {
      expect(data.restarted.every((entry) => entry.detail === detail)).toBe(true);
      expect(data.message).toContain(detail);
    } else {
      expect(data.message).toContain('local cleanup remains pending');
      expect(data.message).toContain('do not start a new command for recovery');
    }
    const withoutWarnings = summarizeBatchResult({ ...options,
      succeeded: batch.succeeded.map(({ name }) => ({ name })), onProgress: undefined });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(withoutWarnings, null, indentation).length)
        .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
  });

  it('settles unknown restart rows without showing successful or failed completion', async () => {
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'web' }, { name: 'cache' }],
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart', onProgress,
      executeOne: async (entry, _index, updateProgress) => {
        updateProgress('failed', 'Response lost; command outcome unknown');
        return { name: entry.name, outcome: 'unconfirmed', detail: 'Recover the original command' };
      },
    });
    const result = summarizeBatchResult({ ...batch, operation: 'restart', onProgress,
      dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts', unconfirmedLabel: 'Outcome unknown' });
    expect(batch.succeeded).toEqual([]);
    expect(batch.failed).toEqual([]);
    expect(batch.unconfirmed).toHaveLength(2);
    expect(batch.batchProgress.every((entry) => entry.phase === 'unconfirmed')).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'unconfirmed', detail: '2 outcome unknown', operation: 'restart',
    }));
    expect(result.data).toEqual(expect.objectContaining({ restarted: [], message: expect.stringContaining('Outcome unknown:') }));
    expect((result.data as { message: string }).message).not.toContain('Restarted:');
  });

  it('keeps the overall result uncertain when successes and unknown outcomes mix', () => {
    const onProgress = vi.fn();
    summarizeBatchResult({ succeeded: [{ name: 'web' }], failed: [], unconfirmed: [{ name: 'cache', outcome: 'unconfirmed' }],
      operation: 'restart', onProgress, dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts', unconfirmedLabel: 'Outcome unknown' });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'unconfirmed', detail: '1 restarted, 1 outcome unknown' }));
    expect(computeOverallPhase(['ready', 'unconfirmed'], ['restarting'])).toBe('unconfirmed');
    expect(computeOverallPhase(['restarting', 'unconfirmed'], ['restarting'])).toBe('restarting');
  });

  it('preserves deploy summary semantics', () => {
    const onProgress = vi.fn();
    summarizeBatchResult({ succeeded: [], failed: [], unconfirmed: [{ name: 'web', outcome: 'unconfirmed' }],
      operation: 'deploy', onProgress, dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys', unconfirmedLabel: 'Still deploying' });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready', detail: '1 still deploying' }));
  });

  it.each([false, true])('preserves named baseline failures in the tool result (partial success: %s)', async (partialSuccess) => {
    const detail = 'Another command is in progress (release v7 is deploying). Wait and check app_releases and app_status before retrying.';
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'blocked' }, ...(partialSuccess ? [{ name: 'healthy' }] : [])],
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart',
      executeOne: async (entry, _index, updateProgress) => {
        if (entry.name === 'blocked') {
          updateProgress('failed', detail);
          return null;
        }
        updateProgress('ready');
        return { name: entry.name };
      },
    });
    const result = summarizeBatchResult({ ...batch, operation: 'restart',
      dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' });
    if (partialSuccess) {
      expect(result.data).toMatchObject({
        failed: ['blocked'],
        message: expect.stringContaining(`blocked: ${detail}`),
      });
      expect(result.data).not.toHaveProperty('failureDetails');
      expect(JSON.stringify(result).split(detail)).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('retrying..');
    } else {
      expect(result).toMatchObject({ success: false, error: `All restarts failed: blocked: ${detail}` });
    }
  });

  it('retains a failed item reason when the remaining items were cancelled', () => {
    const result = summarizeBatchResult({ succeeded: [], failed: ['blocked'], cancelled: ['cancelled'],
      batchProgress: [{ name: 'blocked', phase: 'failed', detail: 'release v7 is deploying.' }],
      operation: 'restart', dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' });
    expect(result.error).toBe('No restarts completed — Failed: blocked: release v7 is deploying. Cancelled: cancelled.');
  });

  it.each([8, 9])('keeps newline-separated diagnostic rows within the serialized budget at %i near-limit entries', (count) => {
    const detail = 'Provider said "no." ' + 'x'.repeat(980) + '.';
    const failed = Array.from({ length: count - 1 }, (_, index) => `failed-${index}`);
    const options = { succeeded: [{ name: 'ready' }], failed, cancelled: ['cancelled'],
      batchProgress: [...failed, 'cancelled'].map(name => ({ name, phase: 'failed' as const, detail })),
      operation: 'restart' as const, dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' };
    const result = summarizeBatchResult(options);
    const without = summarizeBatchResult({ ...options, batchProgress: options.batchProgress.map(({ name, phase }) => ({ name, phase })) });
    const message = (result.data as { message: string }).message;
    expect(message).toMatch(/\nfailed-1: Provider said "no\."/u);
    expect(message.includes('Details were shortened')).toBe(count === 9);
    expect(message).not.toContain('., failed-');
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(without, null, indentation).length)
        .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
  });

  it.each([false, true])('includes a cancelled replay verdict in the tool result (partial success: %s)', async (partialSuccess) => {
    const detail = 'Replay cancelled before any new request. The earlier restart remains verified as succeeded.';
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'cached' }, ...(partialSuccess ? [{ name: 'fresh' }] : [])],
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart',
      executeOne: async ({ name }, _index, progress) => {
        if (name === 'cached') return { name, outcome: 'cancelled', detail };
        progress('ready');
        return { name };
      },
    });
    const result = summarizeBatchResult({ ...batch, operation: 'restart', dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' });
    const text = result.error ?? (result.data as { message: string }).message;
    expect(text).toContain(`Cancelled: cached: ${detail}`);
    expect(text).not.toContain('succeeded..');
    expect(JSON.stringify(result).split(detail)).toHaveLength(2);
  });

  it('budgets cancelled diagnostics once and keeps ordinary cancellation text', () => {
    const cancelled = Array.from({ length: 100 }, (_, index) => `cancelled-${index}`);
    const detail = 'The previous outcome remains verified. ' + 'Diagnostic "detail" \\ 💥 '.repeat(100);
    const options = { succeeded: [], failed: [], cancelled,
      batchProgress: cancelled.map((name) => ({ name, phase: 'failed' as const, detail })),
      operation: 'restart' as const, dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' };
    const result = summarizeBatchResult(options);
    const without = summarizeBatchResult({ ...options, batchProgress: cancelled.map((name) => ({ name, phase: 'failed' as const })) });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(without, null, indentation).length).toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
    expect(result.error).toContain('cancelled-0: The previous outcome remains verified.');
    const ordinary = summarizeBatchResult({ ...options, cancelled: ['app'],
      batchProgress: [{ name: 'app', phase: 'failed', detail: 'Cancelled (batch aborted)' }] });
    expect(ordinary.error).toBe('No restarts completed — Cancelled: app: Cancelled (batch aborted).');
  });

  it.each([undefined, 'deploy'] as const)('does not request observations of never-submitted cancelled deployments in a shortened summary (operation: %s)', async (operation) => {
    const abort = new AbortController();
    const executeOne = vi.fn(async ({ name }: { name: string }, index: number, progress: (phase: 'failed', detail: string) => void) => {
      if (index < 20) {
        progress('failed', 'Container failed to start. '.repeat(35));
        return null;
      }
      abort.abort();
      progress('failed', 'Cancelled before deployment was submitted');
      return { name, outcome: 'cancelled' as const };
    });
    const batch = await runBatchWithConcurrency({
      entries: Array.from({ length: 22 }, (_, index) => ({ name: `app-${index}` })),
      initialPhase: 'creating_lease', intermediatePhases: ['creating_lease'], operation,
      signal: abort.signal, concurrency: 1, executeOne,
    });
    expect(executeOne).toHaveBeenCalledTimes(21);
    expect(batch.cancelled).toEqual(['app-20', 'app-21']);
    const options = { ...batch, operation, dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys' };
    const result = summarizeBatchResult(options);
    expect(result.error).toContain('Details were shortened.');
    expect(result.error).toContain('Cancelled deployments were never submitted; they can be deployed again.');
    expect(result.error).not.toContain('for cancelled apps before requesting new work');
    expect(result.error).not.toContain('app_releases');
    expect(result.error).toContain('app-20: Cancelled before deployment was submitted');
    expect(result.error).toContain('app-21: Cancelled (batch aborted).');
    const without = summarizeBatchResult({ ...options, batchProgress: batch.batchProgress.map(({ name, phase }) => ({ name, phase })) });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(without, null, indentation).length)
        .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
  });

  it.each(['restart', 'update'] as const)('keeps observation guidance and the verified %s verdict for a cancelled replay in a shortened summary', (operation) => {
    const detail = `Recovery cancelled. The previous ${operation} outcome remains verified as succeeded. No new maintenance request was sent.`;
    const failed = Array.from({ length: 20 }, (_, index) => `failed-${index}`);
    const options = {
      succeeded: [{ name: 'fresh' }], failed, cancelled: ['cached'], operation,
      batchProgress: [
        ...failed.map((name) => ({ name, phase: 'failed' as const, detail: 'Provider request failed. '.repeat(35) })),
        { name: 'cached', phase: 'failed' as const, detail },
      ],
      dataKey: operation === 'restart' ? 'restarted' : 'updated',
      verb: operation === 'restart' ? 'Restarted' : 'Updated', failedNoun: `${operation}s`,
    };
    const result = summarizeBatchResult(options);
    const message = (result.data as { message: string }).message;
    expect(message).toContain('Details were shortened.');
    expect(message).toContain('Check app_status and app_releases for cancelled apps before requesting new work.');
    expect(message).toContain(`Cancelled: cached: ${detail}`);
    expect(message).not.toContain('Cancelled deployments were never submitted');
    expect(JSON.stringify(result).split(detail)).toHaveLength(2);
    const without = summarizeBatchResult({ ...options, batchProgress: options.batchProgress.map(({ name, phase }) => ({ name, phase })) });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(without, null, indentation).length)
        .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
  });

  it('finishes a cancelled row even when the per-item executor emitted only active progress', async () => {
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'web' }], initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart', onProgress,
      executeOne: async (entry, _index, updateProgress) => {
        updateProgress('restarting', 'Restart requested...');
        return { name: entry.name, outcome: 'cancelled', detail: 'Restart cancelled before dispatch.' };
      },
    });
    expect(batch.cancelled).toEqual(['web']);
    expect(batch.batchProgress).toEqual([{ name: 'web', phase: 'failed', detail: 'Restart cancelled before dispatch.' }]);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed' }));
  });

  it.each([4, 8, 100])('keeps complete recovery guidance for a batch of %i unknown commands', async (count) => {
    const names = Array.from({ length: count }, (_, index) => `billing-production-service-${index}`);
    const guidance = (name: string) => `Restart outcome for "${name}" is unconfirmed. The provider may retain a pending command that executes later. `
      + `Check app_status("${name}") and app_releases("${name}"). `
      + `Retry restart_app(app_name="${name}") to recover the saved command with its original key and exact payload. `
      + 'Do not submit a new command or stop/redeploy while this outcome is unresolved.';
    const batch = await runBatchWithConcurrency({
      entries: names.map((name) => ({ name })),
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart',
      executeOne: async ({ name }) => ({ name, outcome: 'unconfirmed', detail: guidance(name) }),
    });
    const options = { ...batch, operation: 'restart' as const, dataKey: 'restarted',
      verb: 'Restarted', failedNoun: 'restarts', unconfirmedLabel: 'Outcome unknown' };
    const result = summarizeBatchResult(options);
    const data = result.data as { message: string; unconfirmed: Array<{ name: string; detail?: string }> };
    for (const row of batch.batchProgress) expect(row.detail).toBe(guidance(row.name));
    if (count < 100) {
      for (const entry of data.unconfirmed) {
        expect(entry.detail).toBe(guidance(entry.name));
        expect(data.message).toContain(guidance(entry.name));
      }
      expect(data.message).not.toContain('Details were shortened');
    } else {
      expect(data.message).toContain('Recover only a command still pending, using its original key and exact payload.');
      expect(data.message).toContain('Do not use new_command for recovery.');
      expect(data.message).toContain('Do not submit a new command or automatically stop/redeploy while its outcome is unresolved.');
      const withoutDiagnostics = summarizeBatchResult({ ...options,
        unconfirmed: batch.unconfirmed.map(({ name, outcome }) => ({ name, outcome })) });
      for (const indentation of [undefined, 2]) {
        expect(JSON.stringify(result, null, indentation).length - JSON.stringify(withoutDiagnostics, null, indentation).length)
          .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
      }
    }
  });

  it('keeps the deliberate-abandonment condition when a large deployment summary needs shorter details', () => {
    const failed = ['failed-app'];
    const result = summarizeBatchResult({ succeeded: [], failed,
      batchProgress: [{ name: failed[0], phase: 'failed', detail: 'Container exited. '.repeat(60) }],
      unconfirmed: Array.from({ length: 100 }, (_, index) => ({ name: `app-${index}`, outcome: 'unconfirmed',
        detail: 'The app is still deploying. '.repeat(15) + 'Only stop_app if you have decided to abandon it.' })),
      dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys', unconfirmedLabel: 'Still deploying' });
    expect(result.data).toMatchObject({ message: expect.stringContaining('Check app_status for each still-deploying app. Only use stop_app if you have decided to abandon that deployment.') });
    expect(result.data).toMatchObject({ message: expect.stringContaining('Check app_status and app_diagnostics for each failed app.') });
  });

  it.each([false, true])('bounds serialized diagnostics for a large batch of HTML rejections (partial success: %s)', async (partialSuccess) => {
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: Array.from({ length: 200 }, (_, index) => ({ name: `app-${index}` })),
      initialPhase: 'restarting', intermediatePhases: ['restarting'], operation: 'restart', onProgress,
      executeOne: async (entry, index, updateProgress) => {
        if (partialSuccess && index === 0) {
          updateProgress('ready', 'App is live!');
          return { name: entry.name };
        }
        const detail = `HTTP ${index % 2 === 0 ? 403 : 429}: \u202e<html>\u0000\r\n<title>Request denied</title>`
          + '<body data-error="quoted\\path">💥 forbidden</body>'.repeat(100);
        if (index % 2 === 0) throw new Error(detail.slice(0, 4096));
        updateProgress('failed', detail.slice(0, 4096));
        return null;
      },
    });
    const options = { ...batch, operation: 'restart' as const,
      dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' };
    const result = summarizeBatchResult(options);
    const withoutDiagnostics = summarizeBatchResult({ ...options,
      batchProgress: batch.batchProgress.map(({ name, phase }) => ({ name, phase })) });
    const serialized = JSON.stringify(result);
    expect(serialized.length - JSON.stringify(withoutDiagnostics).length).toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).not.toContain('failureDetails');
    expect(serialized).toContain('app-199: HTTP 429:');
    expect(serialized).toContain('app-198: HTTP 403:');
    expect(result.success).toBe(partialSuccess);
    for (const row of batch.batchProgress.filter((entry) => entry.phase === 'failed')) {
      const safetyNet = Number(row.name.slice(4)) % 2 === 0;
      expect(Array.from(row.detail ?? '').length).toBeLessThanOrEqual((safetyNet ? FAILURE_DETAIL_CHARS : AI_BATCH_GUIDANCE_CHARS) + 1);
      expect(row.detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(row.detail).toContain('<html>');
    }
    for (const [progress] of onProgress.mock.calls) {
      for (const row of progress.batch ?? []) {
        expect(row.detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }
    }
  });

  it('counts both serialized copies of unknown diagnostics and sanitizes summary inputs', () => {
    const detail = 'HTTP 429: \u202e\u0000<html data-message="try\\later">' + '💥'.repeat(4096);
    const failed = Array.from({ length: 100 }, (_, index) => `failed-${index}`);
    const unconfirmed = Array.from({ length: 100 }, (_, index) => ({ name: `unknown-${index}`, outcome: 'unconfirmed' as const, detail }));
    const options = { succeeded: [], failed, unconfirmed,
      batchProgress: failed.map((name) => ({ name, phase: 'failed' as const, detail })),
      operation: 'restart' as const, dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts', unconfirmedLabel: 'Outcome unknown' };
    const onProgress = vi.fn();
    const result = summarizeBatchResult({ ...options, onProgress });
    const withoutDiagnostics = summarizeBatchResult({ ...options,
      batchProgress: failed.map((name) => ({ name, phase: 'failed' as const })),
      unconfirmed: unconfirmed.map(({ name, outcome }) => ({ name, outcome })) });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(withoutDiagnostics, null, indentation).length)
        .toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
    expect(JSON.stringify(result)).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(JSON.stringify(result)).not.toContain('\\u0000');
    expect(result.data).toMatchObject({ failed, unconfirmed: unconfirmed.map(({ name }) => ({ name, detail: expect.stringContaining('HTTP 429:') })) });
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'unconfirmed',
      batch: expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('<html') })]) }));
  });
});
