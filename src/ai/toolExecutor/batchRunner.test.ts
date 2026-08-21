import { describe, it, expect, vi } from 'vitest';
import {
  createSigningMutex,
  computeOverallPhase,
  runBatchWithConcurrency,
  summarizeBatchResult,
  type BatchEntry,
} from './batchRunner';

describe('createSigningMutex', () => {
  it('serializes concurrent signArbitrary calls', async () => {
    const order: number[] = [];
    const signArbitrary = vi.fn(async (_addr: string, data: string) => {
      const id = Number(data);
      order.push(id);
      await new Promise((r) => setTimeout(r, 10));
      order.push(id + 100);
      return { pub_key: { type: 't', value: 'v' }, signature: `sig-${id}` };
    });

    const { signArbitraryWithMutex } = createSigningMutex(signArbitrary);

    // Fire 3 concurrent calls
    const results = await Promise.all([
      signArbitraryWithMutex('addr', '1'),
      signArbitraryWithMutex('addr', '2'),
      signArbitraryWithMutex('addr', '3'),
    ]);

    // Each call should complete before the next starts (serialized)
    expect(order).toEqual([1, 101, 2, 102, 3, 103]);
    expect(results[0].signature).toBe('sig-1');
    expect(results[1].signature).toBe('sig-2');
    expect(results[2].signature).toBe('sig-3');
  });

  it('releases the lock when a signArbitrary call rejects', async () => {
    // ENG-312 Phase 8: withSign is no longer public — exercise lock release via
    // signArbitraryWithMutex (which the internal withSign backs).
    const signArbitrary = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ pub_key: { type: 't', value: 'v' }, signature: 'sig' });
    const { signArbitraryWithMutex } = createSigningMutex(signArbitrary);

    await expect(signArbitraryWithMutex('addr', 'a')).rejects.toThrow('boom');

    // Next call still works → the lock was released after the rejection.
    const result = await signArbitraryWithMutex('addr', 'b');
    expect(result.signature).toBe('sig');
  });
});

describe('computeOverallPhase', () => {
  it('returns ready when all phases are ready', () => {
    expect(computeOverallPhase(['ready', 'ready'], ['provisioning'])).toBe('ready');
  });

  it('returns failed when all terminal and none ready', () => {
    expect(computeOverallPhase(['failed', 'failed'], ['provisioning'])).toBe('failed');
  });

  it('returns ready when mix of ready and failed', () => {
    expect(computeOverallPhase(['ready', 'failed'], ['provisioning'])).toBe('ready');
  });

  it('returns highest priority intermediate phase', () => {
    const phases = ['provisioning', 'creating_lease', 'ready'] as const;
    // provisioning is first in the priority list, so it wins
    expect(computeOverallPhase([...phases], ['provisioning', 'uploading', 'creating_lease'])).toBe('provisioning');
  });

  it('returns uploading when present and provisioning is not', () => {
    const phases = ['uploading', 'creating_lease'] as const;
    expect(computeOverallPhase([...phases], ['provisioning', 'uploading', 'creating_lease'])).toBe('uploading');
  });

  it('returns phase when it is the only matching intermediate', () => {
    expect(computeOverallPhase(['restarting'], ['provisioning', 'restarting'])).toBe('restarting');
  });

  it('uses restart intermediate phases correctly', () => {
    const phases = ['provisioning', 'restarting', 'ready'] as const;
    expect(computeOverallPhase([...phases], ['provisioning', 'restarting'])).toBe('provisioning');
  });
});

describe('runBatchWithConcurrency', () => {
  const makeEntry = (name: string): BatchEntry => ({ name });

  it('runs all entries and returns succeeded/failed', async () => {
    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      executeOne: async (entry, _i, updateProgress) => {
        updateProgress('provisioning', 'Working...');
        updateProgress('ready', 'Done!');
        return { name: entry.name };
      },
    });

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('records failures when executeOne returns null', async () => {
    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      executeOne: async (entry, _i, updateProgress) => {
        if (entry.name === 'b') {
          updateProgress('failed', 'Something broke');
          return null;
        }
        return { name: entry.name };
      },
    });

    expect(result.succeeded).toEqual([{ name: 'a' }]);
    expect(result.failed).toEqual(['b']);
    expect(result.batchProgress[1].phase).toBe('failed');
    expect(result.batchProgress[1].detail).toBe('Something broke');
  });

  it('catches thrown errors as failures', async () => {
    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      executeOne: async () => {
        throw new Error('unexpected');
      },
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toEqual(['a']);
    expect(result.batchProgress[0].phase).toBe('failed');
    expect(result.batchProgress[0].detail).toBe('unexpected');
  });

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b'), makeEntry('c'), makeEntry('d')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      concurrency: 2,
      executeOne: async (entry) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { name: entry.name };
      },
    });

    expect(result.succeeded).toHaveLength(4);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('stops queuing new tasks when signal is aborted', async () => {
    const controller = new AbortController();
    let started = 0;

    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b'), makeEntry('c')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      concurrency: 1,
      signal: controller.signal,
      executeOne: async (entry) => {
        started++;
        if (started === 1) controller.abort();
        return { name: entry.name };
      },
    });

    // First task ran and triggered abort; second may have been queued before check
    expect(started).toBeLessThanOrEqual(2);
    expect(result.succeeded.length).toBeLessThanOrEqual(2);
  });

  it('buckets un-queued entries as cancelled when aborted mid-batch', async () => {
    const controller = new AbortController();
    let started = 0;

    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b'), makeEntry('c')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'restarting',
      concurrency: 1,
      signal: controller.signal,
      executeOne: async (entry) => {
        started++;
        // Abort inside executeOne after the first entry so b/c are never queued.
        if (started === 1) controller.abort();
        return { name: entry.name };
      },
    });

    // Every entry is accounted for across the three buckets.
    expect(result.succeeded.length + result.failed.length + result.cancelled.length).toBe(3);
    expect(result.cancelled.length).toBeGreaterThan(0);
    // Cancelled entries' progress rows reflect the aborted status.
    for (const name of result.cancelled) {
      const row = result.batchProgress.find((b) => b.name === name);
      expect(row?.phase).toBe('failed');
      expect(row?.detail).toBe('Cancelled (batch aborted)');
    }
  });

  it('buckets an executeOne outcome verdict away from succeeded', async () => {
    // `null` = failed and a bare item = succeeded are not enough: an operation
    // the provider never gave a verdict on, and one aborted before the provider
    // was asked, are neither — and rounding them into `succeeded` is what let
    // the summary claim "All N apps deployed!" for an unconfirmed deploy.
    const result = await runBatchWithConcurrency({
      entries: [makeEntry('a'), makeEntry('b'), makeEntry('c'), makeEntry('d')],
      intermediatePhases: ['provisioning'],
      initialPhase: 'creating_lease',
      executeOne: async (entry) => {
        if (entry.name === 'b') return { name: entry.name, outcome: 'unconfirmed' as const, detail: 'may still be starting' };
        if (entry.name === 'c') return { name: entry.name, outcome: 'cancelled' as const };
        if (entry.name === 'd') return null;
        return { name: entry.name };
      },
    });

    expect(result.succeeded).toEqual([{ name: 'a' }]);
    expect(result.unconfirmed).toEqual([{ name: 'b', outcome: 'unconfirmed', detail: 'may still be starting' }]);
    expect(result.cancelled).toEqual(['c']);
    expect(result.failed).toEqual(['d']);
  });

  it('emits progress with operation field when set', async () => {
    const onProgress = vi.fn();

    await runBatchWithConcurrency({
      entries: [makeEntry('a')],
      intermediatePhases: ['provisioning', 'restarting'],
      initialPhase: 'restarting',
      operation: 'restart',
      onProgress,
      executeOne: async (entry) => ({ name: entry.name }),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'restart' })
    );
  });

  it('does not include operation field when not set', async () => {
    const onProgress = vi.fn();

    await runBatchWithConcurrency({
      entries: [makeEntry('a')],
      intermediatePhases: ['provisioning', 'creating_lease'],
      initialPhase: 'creating_lease',
      onProgress,
      executeOne: async (entry) => ({ name: entry.name }),
    });

    // First call should NOT have operation field
    const firstCall = onProgress.mock.calls[0][0];
    expect(firstCall).not.toHaveProperty('operation');
  });
});

describe('summarizeBatchResult', () => {
  it('returns success with correct data key for all succeeded', () => {
    const result = summarizeBatchResult({
      succeeded: [{ name: 'a', url: 'http://a' }, { name: 'b' }],
      failed: [],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
    });

    expect(result.success).toBe(true);
    expect((result.data as any).deployed).toHaveLength(2);
    expect((result.data as any).failed).toHaveLength(0);
    expect((result.data as any).message).toContain('Deployed');
  });

  it('returns failure when all entries failed', () => {
    const result = summarizeBatchResult({
      succeeded: [],
      failed: ['a', 'b'],
      dataKey: 'restarted',
      verb: 'Restarted',
      failedNoun: 'restarts',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('All restarts failed');
    expect(result.error).toContain('a, b');
  });

  it('returns success with partial failures', () => {
    const result = summarizeBatchResult({
      succeeded: [{ name: 'a' }],
      failed: ['b'],
      dataKey: 'restarted',
      verb: 'Restarted',
      failedNoun: 'restarts',
    });

    expect(result.success).toBe(true);
    expect((result.data as any).message).toContain('Restarted');
    expect((result.data as any).message).toContain('Failed: b');
  });

  it('emits final progress when onProgress is provided', () => {
    const onProgress = vi.fn();
    const batchProgress = [
      { name: 'a', phase: 'ready' as const },
      { name: 'b', phase: 'failed' as const, detail: 'oops' },
    ];

    summarizeBatchResult({
      succeeded: [{ name: 'a' }],
      failed: ['b'],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      batchProgress,
      operation: 'restart',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'ready',
        operation: 'restart',
        batch: expect.arrayContaining([
          expect.objectContaining({ name: 'a', phase: 'ready' }),
        ]),
      })
    );
  });

  it('reports cancelled entries alongside a success', () => {
    const result = summarizeBatchResult({
      succeeded: [{ name: 'a' }],
      failed: [],
      cancelled: ['b', 'c'],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
    });

    expect(result.success).toBe(true);
    expect((result.data as any).cancelled).toEqual(['b', 'c']);
    expect((result.data as any).message).toContain('Cancelled: b, c');
  });

  it('returns failure naming cancelled when everything was cancelled', () => {
    const result = summarizeBatchResult({
      succeeded: [],
      failed: [],
      cancelled: ['a', 'b'],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cancelled: a, b');
    expect(result.error).not.toContain('All deploys failed');
  });

  it('reports unconfirmed entries under their own label, never as deployed', () => {
    const onProgress = vi.fn();
    const result = summarizeBatchResult({
      succeeded: [{ name: 'a' }],
      failed: [],
      unconfirmed: [{ name: 'postgres', outcome: 'unconfirmed', detail: 'may still be starting' }],
      unconfirmedLabel: 'Still deploying',
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress,
    });

    expect(result.success).toBe(true);
    expect((result.data as any).deployed).toEqual([{ name: 'a' }]);
    expect((result.data as any).unconfirmed).toHaveLength(1);
    expect((result.data as any).message).toContain('Still deploying:');
    expect((result.data as any).message).toContain('postgres: may still be starting');
    // The headline claim must not swallow the unconfirmed entry.
    expect(onProgress.mock.calls[0][0].detail).not.toContain('All 1 app deployed!');
    expect(onProgress.mock.calls[0][0].detail).toContain('1 still deploying');
  });

  it('does not report an all-unconfirmed batch as an all-failed one', () => {
    const result = summarizeBatchResult({
      succeeded: [],
      failed: [],
      unconfirmed: [{ name: 'postgres', outcome: 'unconfirmed', detail: 'may still be starting' }],
      unconfirmedLabel: 'Still deploying',
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect((result.data as any).message).toContain('Still deploying:');
  });

  it('never prints a zero count in the progress detail', () => {
    const onProgress = vi.fn();
    summarizeBatchResult({
      succeeded: [],
      failed: [],
      unconfirmed: [{ name: 'postgres', outcome: 'unconfirmed' }],
      unconfirmedLabel: 'Still deploying',
      cancelled: [],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress,
    });

    expect(onProgress.mock.calls[0][0].detail).toBe('1 still deploying');
  });

  it('keeps the progress phase and the ToolResult verdict in agreement', () => {
    // All-unconfirmed: nothing failed, so the card must not read 'failed' while
    // the ToolResult reports success.
    const unconfirmedProgress = vi.fn();
    const unconfirmedResult = summarizeBatchResult({
      succeeded: [],
      failed: [],
      unconfirmed: [{ name: 'postgres', outcome: 'unconfirmed' }, { name: 'redis', outcome: 'unconfirmed' }],
      unconfirmedLabel: 'Still deploying',
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress: unconfirmedProgress,
    });
    expect(unconfirmedResult.success).toBe(true);
    expect(unconfirmedProgress.mock.calls[0][0].phase).toBe('ready');
    expect(unconfirmedProgress.mock.calls[0][0].detail).toBe('2 still deploying');

    // Nothing landed: both surfaces say failed.
    const failedProgress = vi.fn();
    const failedResult = summarizeBatchResult({
      succeeded: [],
      failed: ['a'],
      cancelled: ['b'],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress: failedProgress,
    });
    expect(failedResult.success).toBe(false);
    expect(failedProgress.mock.calls[0][0].phase).toBe('failed');
    expect(failedProgress.mock.calls[0][0].detail).toBe('1 failed, 1 cancelled');
  });

  it('keeps the all-succeeded headline and drops it as soon as anything else lands', () => {
    const allOk = vi.fn();
    summarizeBatchResult({
      succeeded: [{ name: 'a' }, { name: 'b' }],
      failed: [],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress: allOk,
    });
    expect(allOk.mock.calls[0][0].detail).toBe('All 2 apps deployed!');

    const mixed = vi.fn();
    summarizeBatchResult({
      succeeded: [{ name: 'a' }],
      failed: [],
      cancelled: ['b'],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress: mixed,
    });
    expect(mixed.mock.calls[0][0].detail).toBe('1 deployed, 1 cancelled');
  });

  it('emits a sensible detail for an empty batch instead of "All 0 apps"', () => {
    const onProgress = vi.fn();
    summarizeBatchResult({
      succeeded: [],
      failed: [],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
      onProgress,
    });

    expect(onProgress.mock.calls[0][0].detail).toBe('No apps deployed');
  });

  it('formats URLs in succeeded entries', () => {
    const result = summarizeBatchResult({
      succeeded: [{ name: 'app1', url: 'http://app1.example.com' }],
      failed: [],
      dataKey: 'deployed',
      verb: 'Deployed',
      failedNoun: 'deploys',
    });

    expect((result.data as any).message).toContain('app1: http://app1.example.com');
  });
});
