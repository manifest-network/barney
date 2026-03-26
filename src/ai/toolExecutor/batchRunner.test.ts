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

  it('withSign serializes arbitrary async functions', async () => {
    const signArbitrary = vi.fn().mockResolvedValue({
      pub_key: { type: 't', value: 'v' },
      signature: 'sig',
    });
    const { withSign } = createSigningMutex(signArbitrary);

    const order: string[] = [];
    const task = (label: string) => withSign(async () => {
      order.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${label}-end`);
      return label;
    });

    const results = await Promise.all([task('a'), task('b')]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(results).toEqual(['a', 'b']);
  });

  it('releases lock on error', async () => {
    const signArbitrary = vi.fn().mockResolvedValue({
      pub_key: { type: 't', value: 'v' },
      signature: 'sig',
    });
    const { withSign } = createSigningMutex(signArbitrary);

    const failing = withSign(async () => { throw new Error('boom'); });
    await expect(failing).rejects.toThrow('boom');

    // Next call should still work (lock was released)
    const result = await withSign(async () => 'ok');
    expect(result).toBe('ok');
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

  it('returns initial phase when no intermediate matches', () => {
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
