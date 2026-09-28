import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ChatMessage } from '../../contexts/aiTypes';
import { AI_HISTORY_ERROR_CHARS, FAILURE_DETAIL_CHARS } from '../../config/constants';
import { validateChatHistory } from '../../ai/validation';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
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
    expect(restored[0]).not.toHaveProperty('errorFormat');
    saveHistory(identity, restored, true);
    expect(JSON.parse(localStorage.getItem(storageKey)!).data.messages[0].errorFormat).toBe('authored');
    expect(loadHistory(identity)[0].error).toBe(result.error);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => { root!.render(createElement(MessageBubble, { message: restored[0] })); });
    const alert = container.querySelector('[role="alert"] > span');
    expect(alert?.textContent).toBe(result.error);
    for (const name of names) expect(alert?.textContent).toContain(`${name}: Restart failed: ${name}`);
  });

  it.each(['save', 'authored load'] as const)('bounds oversized errors without dropping their alert during %s', (boundary) => {
    const original = `Useful first line\n${'x'.repeat(AI_HISTORY_ERROR_CHARS * 4)}`;
    const input = message(original);
    if (boundary === 'save') {
      saveHistory(identity, [input], true);
      expect(JSON.parse(localStorage.getItem(storageKey)!).data.messages[0].error.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
    } else localStorage.setItem(storageKey, JSON.stringify({ v: 1, data: { identity, messages: [{ ...input, errorFormat: 'authored' }] } }));
    const restored = loadHistory(identity);
    expect(restored[0].error!.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
    expect(restored[0].error).toMatch(/^Useful first line\n/);
    expect(restored[0].error).toContain('[Part of this saved error was omitted.]');
    expect(input.error).toBe(original);
    saveHistory(identity, restored, true);
    const saved = JSON.parse(localStorage.getItem(storageKey)!).data.messages[0];
    expect(saved.error).toBe(restored[0].error);
    expect(saved.error.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
  });

  it('preserves an error exactly at the storage bound', () => {
    const error = `First row\n${'x'.repeat(AI_HISTORY_ERROR_CHARS - 10)}`;
    expect(error).toHaveLength(AI_HISTORY_ERROR_CHARS);
    saveHistory(identity, [message(error)], true);
    expect(loadHistory(identity)[0].error).toBe(error);
  });

  it('keeps surrogate pairs intact at both truncation boundaries', () => {
    const original = `x${'😀'.repeat(AI_HISTORY_ERROR_CHARS)}z`;
    saveHistory(identity, [message(original)], true);
    const restored = loadHistory(identity)[0].error!;
    expect(restored.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
    expect(restored).toMatch(/^x😀/u);
    expect(restored).toMatch(/😀z$/u);
    expect(restored).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(restored).toContain('[Part of this saved error was omitted.]');
  });

  it.each([2049, 6000, 10240])('sanitizes an unmarked %i-character legacy HTML error before rendering or resaving', (length) => {
    const raw = `<html>\n<script>challenge</script>\n\u0000\u202e${'gateway page\n'.repeat(1000)}`.slice(0, length);
    localStorage.setItem(storageKey, JSON.stringify({ v: 1, data: { identity, messages: [message(raw)] } }));
    const restored = loadHistory(identity);
    expect(restored[0].error).toBe(sanitizeForDisplay(raw, FAILURE_DETAIL_CHARS));
    expect(Array.from(restored[0].error!)).toHaveLength(FAILURE_DETAIL_CHARS + 1);
    expect(restored[0].error).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(restored[0]).not.toHaveProperty('errorFormat');
    saveHistory(identity, restored, true);
    expect(JSON.parse(localStorage.getItem(storageKey)!).data.messages[0]).toMatchObject({ error: restored[0].error, errorFormat: 'authored' });
    expect(loadHistory(identity)[0].error).toBe(restored[0].error);
  });

  it.each([undefined, null, false, 42, {}, [], 'raw', 'authored-v2'].map((format) => ({ format })))('sanitizes short legacy control text with absent or invalid marker $format', ({ format }) => {
    const raw = 'Provider\nerror\u0000with\u202econtrols';
    localStorage.setItem(storageKey, JSON.stringify({ v: 1, data: { identity, messages: [{ ...message(raw), errorFormat: format }] } }));
    expect(loadHistory(identity)[0].error).toBe('Provider error with controls');
    expect(loadHistory(identity)[0]).not.toHaveProperty('errorFormat');
  });

  it('does not let a malformed format marker discard advice or transient metadata', () => {
    const advice = { operation: 'restart', idempotencyKey: '11111111-1111-4111-8111-111111111111',
      address: identity.address, chainId: identity.chainId, providerUrl: 'https://provider.example',
      leaseUuid: '22222222-2222-4222-8222-222222222222', rpcUrl: 'https://rpc.example', restUrl: 'https://rest.example' };
    const restored = validateChatHistory([{ ...message('raw\nerror'), errorFormat: { invalid: true },
      maintenanceRecoveryAdvice: [advice], isStreaming: true, awaitingConfirmation: true, transactionInFlight: true, local: true }]);
    expect(restored).toMatchObject([{ error: 'raw error', maintenanceRecoveryAdvice: [advice],
      isStreaming: true, awaitingConfirmation: true, transactionInFlight: true, local: true }]);
    expect(restored[0]).not.toHaveProperty('errorFormat');
  });

  it('keeps first rows and complete ending guidance from a large authored batch after save/load/render', () => {
    const names = Array.from({ length: 80 }, (_, index) => `service-${String(index).padStart(3, '0')}-${'n'.repeat(20)}`);
    const result = summarizeBatchResult({
      succeeded: [], failed: names,
      batchProgress: names.map((name) => ({ name, phase: 'failed' as const,
        detail: `Restart failed: ${'diagnostic '.repeat(100)}` })),
      operation: 'restart', dataKey: 'restarted', verb: 'Restarted', failedNoun: 'restarts',
    });
    const original = result.error!;
    expect(original.length).toBeGreaterThan(AI_HISTORY_ERROR_CHARS);
    const guidance = original.slice(original.lastIndexOf('Details were shortened.'));
    expect(guidance).toContain('Check app_status and app_diagnostics');
    saveHistory(identity, [message(original)], true);
    const restored = loadHistory(identity);
    expect(restored[0].error!.length).toBeLessThanOrEqual(AI_HISTORY_ERROR_CHARS);
    expect(restored[0].error).toContain(`${names[0]}: Restart failed`);
    expect(restored[0].error).toContain(`${names.at(-1)}: Restart failed`);
    expect(restored[0].error).toContain('\n… [Part of this saved error was omitted.] …\n');
    expect(restored[0].error!.endsWith(guidance)).toBe(true);
    expect(result.error).toBe(original);
    saveHistory(identity, restored, true);
    expect(loadHistory(identity)[0].error).toBe(restored[0].error);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => { root!.render(createElement(MessageBubble, { message: restored[0] })); });
    expect(container.querySelector('[role="alert"] > span')?.textContent).toBe(restored[0].error);
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
