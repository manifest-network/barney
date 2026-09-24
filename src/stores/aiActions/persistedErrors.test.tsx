import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ChatMessage } from '../../contexts/aiTypes';
import { AI_HISTORY_ERROR_CHARS } from '../../config/constants';
import { summarizeBatchResult } from '../../ai/toolExecutor/batchRunner';
import { MessageBubble } from '../../components/ai/MessageBubble';
import { createWalletIdentity } from '../../utils/walletIdentity';
import { historyStorageKey, loadHistory, saveHistory } from './persistence';

vi.mock('../../contexts/aiStoreContext', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => selector({
    sendMessage: vi.fn(), retrySkuTiers: vi.fn(async () => undefined),
  }),
}));

const identity = createWalletIdentity('manifest-test', 'manifest1errorhistory')!;
const storageKey = historyStorageKey(identity);
const message = (error: unknown): ChatMessage => ({
  id: 'batch-error', role: 'tool', toolName: 'restart_app', content: '', timestamp: 1,
  error: error as string,
});
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  flushSync(() => { root?.unmount(); });
  root = undefined;
  container?.remove();
  container = undefined;
});

describe('persisted chat error diagnostics', () => {
  it('keeps a real three-app batch failure alert intact through save, reload and render', () => {
    const names = ['aaa', 'bbb', 'ccc'];
    const result = summarizeBatchResult({
      succeeded: [], failed: names,
      batchProgress: names.map((name) => ({ name, phase: 'failed' as const,
        detail: `Restart failed: ${name} ${'diagnostic '.repeat(80)}complete.` })),
      operation: 'restart', dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts',
    });
    expect(result.success).toBe(false);
    expect(result.error!.length).toBeGreaterThan(2048);
    expect(result.error!.length).toBeLessThan(AI_HISTORY_ERROR_CHARS);
    saveHistory(identity, [message(result.error)], true);
    const restored = loadHistory(identity);
    expect(restored).toHaveLength(1);
    expect(restored[0].error).toBe(result.error);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => { root!.render(createElement(MessageBubble, { message: restored[0] })); });
    const alert = container.querySelector('[role="alert"] > span');
    expect(alert?.textContent).toBe(result.error);
    for (const name of names) expect(alert?.textContent).toContain(`${name}: Restart failed: ${name}`);
  });

  it.each(['save', 'legacy load'] as const)('bounds oversized errors without dropping their alert during %s', (boundary) => {
    const original = `Useful first line\n${'x'.repeat(AI_HISTORY_ERROR_CHARS * 4)}`;
    const input = message(original);
    if (boundary === 'save') {
      saveHistory(identity, [input], true);
      expect(JSON.parse(localStorage.getItem(storageKey)!).data.messages[0].error).toHaveLength(AI_HISTORY_ERROR_CHARS);
    } else localStorage.setItem(storageKey, JSON.stringify({ v: 1, data: { identity, messages: [input] } }));
    const restored = loadHistory(identity);
    expect(restored[0].error).toHaveLength(AI_HISTORY_ERROR_CHARS);
    expect(restored[0].error).toMatch(/^Useful first line\n/);
    expect(restored[0].error).toMatch(/…$/u);
    expect(input.error).toBe(original);
    saveHistory(identity, restored, true);
    const saved = JSON.parse(localStorage.getItem(storageKey)!).data.messages[0];
    expect(saved.error).toBe(restored[0].error);
    expect(saved.error).toHaveLength(AI_HISTORY_ERROR_CHARS);
  });

  it('preserves an error exactly at the storage bound', () => {
    const error = `First row\n${'x'.repeat(AI_HISTORY_ERROR_CHARS - 10)}`;
    expect(error).toHaveLength(AI_HISTORY_ERROR_CHARS);
    saveHistory(identity, [message(error)], true);
    expect(loadHistory(identity)[0].error).toBe(error);
  });

  it('keeps a surrogate pair intact at the truncation boundary', () => {
    saveHistory(identity, [message(`${'x'.repeat(AI_HISTORY_ERROR_CHARS - 2)}😀more`)], true);
    const restored = loadHistory(identity)[0].error!;
    expect(restored.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
    expect(restored).toBe(`${'x'.repeat(AI_HISTORY_ERROR_CHARS - 2)}…`);
  });

  it.each([null, false, 42, { message: 'malformed' }, ['malformed']].map((error) => ({ error })))('omits malformed error $error without losing the message', ({ error }) => {
    const input = message(error);
    saveHistory(identity, [input], true);
    expect(JSON.parse(localStorage.getItem(storageKey)!).data.messages[0]).not.toHaveProperty('error');
    expect(loadHistory(identity)).toMatchObject([{ id: input.id }]);
    expect(loadHistory(identity)[0].error).toBeUndefined();
    localStorage.setItem(storageKey, JSON.stringify({ v: 1, data: { identity, messages: [input] } }));
    expect(loadHistory(identity)).toMatchObject([{ id: input.id }]);
    expect(loadHistory(identity)[0].error).toBeUndefined();
  });
});
