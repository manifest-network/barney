import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '../../contexts/aiTypes';

const sendMessage = vi.fn();
// Return a resolved promise — MessageBubble calls `retrySkuTiers().catch(...)`,
// so a bare `vi.fn()` (returning undefined) would throw on `.catch`.
const retrySkuTiers = vi.fn(() => Promise.resolve());

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ sendMessage, retrySkuTiers }),
}));

import { MessageBubble } from './MessageBubble';

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
