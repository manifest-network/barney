import { describe, expect, it, vi } from 'vitest';
import { AI_BATCH_DIAGNOSTIC_CHARS } from '../../config/constants';
import { FAILURE_DETAIL_CHARS } from './helpers';
import { computeOverallPhase, runBatchWithConcurrency, summarizeBatchResult } from './batchRunner';

describe('maintenance batch uncertainty', () => {
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
      batchProgress: [{ name: 'blocked', phase: 'failed', detail: 'release v7 is deploying' }],
      operation: 'restart', dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts' });
    expect(result.error).toContain('Failed: blocked: release v7 is deploying.');
    expect(result.error).toContain('Cancelled: cancelled.');
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
      expect(Array.from(row.detail ?? '').length).toBeLessThanOrEqual(FAILURE_DETAIL_CHARS + 1);
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
