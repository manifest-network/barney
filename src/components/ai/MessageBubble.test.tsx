import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../../contexts/aiTypes';

const sendMessage = vi.fn();
// Return a resolved promise — MessageBubble calls `retrySkuTiers().catch(...)`,
// so a bare `vi.fn()` (returning undefined) would throw on `.catch`.
const retrySkuTiers = vi.fn(() => Promise.resolve());

// MessageBubble now reads the two stable action refs via narrow `useAIStore`
// selectors (not the broad `useAI()`), so mock the selector hook to run the
// selector against a minimal state object.
vi.mock('../../contexts/aiStoreContext', () => ({
  useAIStore: (selector: (s: { sendMessage: unknown; retrySkuTiers: unknown }) => unknown) =>
    selector({ sendMessage, retrySkuTiers }),
}));

import { MessageBubble } from './MessageBubble';
import { TRANSACTION_FINISHED_AFTER_CONTEXT_CHANGE_MESSAGE } from '../../stores/authorization';
import { summarizeBatchResult } from '../../ai/toolExecutor/batchRunner';
import { historyStorageKey, loadHistory, saveHistory } from '../../stores/aiActions/persistence';
import { createWalletIdentity } from '../../utils/walletIdentity';

let container: HTMLDivElement;
let root: Root;

function render(message: ChatMessage) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root.render(createElement(MessageBubble, { message }));
  });
}

function makeError(error: string): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    error,
    local: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  flushSync(() => {
    root?.unmount();
  });
  container?.remove();
});

function findButton(label: RegExp | string): HTMLButtonElement | null {
  const buttons = container.querySelectorAll('button');
  return Array.from(buttons).find((b) => {
    const txt = b.textContent ?? '';
    return typeof label === 'string' ? txt.trim() === label : label.test(txt);
  }) ?? null;
}

describe('MessageBubble — card details', () => {
  it('renders log output once without a second raw JSON disclosure', () => {
    const data = { app_name: 'web', logs: { web: 'Unique application log line' }, truncated: false };
    render({ id: 'logs', role: 'tool', timestamp: 1, toolName: 'get_logs', toolDescription: 'Getting logs for web',
      content: JSON.stringify(data), card: { type: 'logs', data } });
    expect(container.querySelector('.log-card')?.textContent).toContain('Unique application log line');
    expect(container.textContent?.split('Unique application log line')).toHaveLength(2);
    expect(container.querySelector('.message-tool-block')).toBeNull();
  });

  it('retains extra app metadata in the app overview disclosure', () => {
    render({ id: 'app', role: 'tool', timestamp: 1, toolName: 'app_status', toolDescription: 'Checking web',
      content: JSON.stringify({ name: 'web', image: 'nginx', size: 'small' }),
      card: { type: 'app', data: { name: 'web', status: 'running' } } });
    expect(container.querySelector('.app-card')).not.toBeNull();
    const details = findButton('Details');
    expect(details).not.toBeNull();
    flushSync(() => { details!.click(); });
    expect(container.querySelector('.message-tool-content')?.textContent).toContain('nginx');
  });
});

describe('MessageBubble — error alerts', () => {
  it('uses source-row recovery advice for a failed status query instead of a signing retry suggestion', () => {
    render({ ...makeError('Wallet rejected signature'), role: 'tool', toolName: 'app_status',
      maintenanceRecoveryAdvice: [{ operation: 'update', idempotencyKey: '11111111-1111-4111-8111-111111111111',
        address: 'manifest1recovery', chainId: 'manifest-test', providerUrl: 'https://provider.example',
        leaseUuid: '22222222-2222-4222-8222-222222222222', rpcUrl: 'https://rpc.example', restUrl: 'https://rest.example' }] });
    expect(findButton('Try again')).toBeNull();
    expect(findButton('Deploy an app')).toBeNull();
    expect(findButton('Check status')).not.toBeNull();
  });

  it.each(['restart_app', 'update_app'].flatMap(toolName => [false, true].map(reloaded => ({ toolName, reloaded }))))(
    'offers observation rather than deployment for $toolName recovery (reloaded: $reloaded)', ({ toolName, reloaded }) => {
      const identity = createWalletIdentity('manifest-test', 'manifest1recovery')!;
      const message: ChatMessage = { ...makeError('Outcome unknown. Recover the original command with its same key and exact payload. Do not submit a new command.'),
        role: 'tool', toolName, local: false };
      try {
        if (reloaded) saveHistory(identity, [message], true);
        render(reloaded ? loadHistory(identity)[0] : message);
        expect(findButton('Deploy an app')).toBeNull();
        expect(findButton('Try again')).toBeNull();
        const check = findButton('Check status');
        expect(check).not.toBeNull();
        flushSync(() => { check!.click(); });
        expect(sendMessage).toHaveBeenCalledWith('Check app_status and app_releases for the affected apps before any further maintenance.');
      } finally { localStorage.removeItem(historyStorageKey(identity)); }
    },
  );

  it('preserves visible rows and wrapping in a batch failure alert', () => {
    const result = summarizeBatchResult({
      succeeded: [], failed: ['aaa', 'bbb'], cancelled: ['ccc', 'ddd'],
      batchProgress: [
        { name: 'aaa', phase: 'failed', detail: 'Lease creation failed: insufficient funds' },
        { name: 'bbb', phase: 'failed', detail: 'Provisioning failed: ImagePullFailed' },
        { name: 'ccc', phase: 'failed', detail: 'Cancelled before the provider was asked' },
        { name: 'ddd', phase: 'failed', detail: 'Cancelled (batch aborted)' },
      ],
      operation: 'deploy', dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys',
    });
    expect(result.success).toBe(false);
    const style = document.createElement('style');
    // Load the application's rules without the build-time Tailwind import.
    const stylesheetPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css');
    style.textContent = readFileSync(stylesheetPath, 'utf8').replace(/^@import[^\n]+/gm, '');
    document.head.appendChild(style);
    try {
      render(makeError(result.error!));
      const text = container.querySelector<HTMLElement>('.message-error > span')!;
      expect(text.textContent).toContain('insufficient funds\nbbb:');
      expect(text.textContent).toContain('\nCancelled: ccc:');
      expect(text.textContent).toContain('provider was asked\nddd:');
      expect(getComputedStyle(text).whiteSpace).toBe('pre-line');
      expect(getComputedStyle(text).wordBreak).toBe('break-word');
      expect(getComputedStyle(text.parentElement!).alignItems).toBe('flex-start');
    } finally { style.remove(); }
  });
});

describe('MessageBubble — ERROR_PATTERNS for tier catalog', () => {
  it('renders a Retry button for the executor "Tier catalog unavailable" message and clicking invokes retrySkuTiers', () => {
    render(makeError('Tier catalog unavailable — try again in a moment.'));
    expect(container.textContent).toContain('Tier catalog unavailable');
    const retryBtn = findButton(/^Retry$/);
    expect(retryBtn).not.toBeNull();
    flushSync(() => {
      retryBtn!.click();
    });
    expect(retrySkuTiers).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('matches case-insensitively', () => {
    render(makeError('tier catalog unavailable'));
    expect(findButton(/^Retry$/)).not.toBeNull();
  });

  it('does not match unrelated error text', () => {
    render(makeError('Some unrelated tool failure happened.'));
    expect(findButton(/^Retry$/)).toBeNull();
  });

  it('does not derive error suggestions from neutral message content', () => {
    render({
      id: 'm-neutral',
      role: 'assistant',
      content: `${TRANSACTION_FINISHED_AFTER_CONTEXT_CHANGE_MESSAGE} Added 5 credits.`,
      timestamp: Date.now(),
      local: true,
    });

    expect(container.textContent).toContain('Added 5 credits');
    expect(findButton(/^Check credits$/)).toBeNull();
  });

  it('logs but does not throw when retrySkuTiers rejects', async () => {
    retrySkuTiers.mockRejectedValueOnce(new Error('boom'));
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(makeError('Tier catalog unavailable — try again in a moment.'));
    const retryBtn = findButton(/^Retry$/);
    flushSync(() => {
      retryBtn!.click();
    });
    // Give the microtask a tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(retrySkuTiers).toHaveBeenCalledTimes(1);
    consoleErr.mockRestore();
  });
});
