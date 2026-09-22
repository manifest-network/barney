import { describe, expect, it, vi } from 'vitest';
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
});
