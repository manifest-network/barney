import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '../../contexts/aiTypes';

const sendMessage = vi.fn();
const retrySkuTiers = vi.fn();

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

describe('MessageBubble — ERROR_PATTERNS for tier rejections', () => {
  it('renders a Retry button for "Deploy unavailable: <chain msg>." and clicking it invokes retrySkuTiers', () => {
    render(makeError('Deploy unavailable: chain unreachable.'));
    expect(container.textContent).toContain('Deploy unavailable: chain unreachable.');
    const retryBtn = findButton(/^Retry$/);
    expect(retryBtn).not.toBeNull();
    flushSync(() => {
      retryBtn!.click();
    });
    expect(retrySkuTiers).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('renders a Retry button for the generic-fallback wording too', () => {
    render(makeError('Deploy unavailable: tier catalog not ready.'));
    const retryBtn = findButton(/^Retry$/);
    expect(retryBtn).not.toBeNull();
    flushSync(() => {
      retryBtn!.click();
    });
    expect(retrySkuTiers).toHaveBeenCalledTimes(1);
  });

  it('renders a Retry button for the loading-state wording', () => {
    render(makeError('Deploy unavailable: tier catalog is still loading. Please wait a moment and try again.'));
    const retryBtn = findButton(/^Retry$/);
    expect(retryBtn).not.toBeNull();
  });

  it('renders a "List apps" suggestion (no Retry) for stale-size rejection', () => {
    render(makeError("Tier 'gpu-large' is not available on this network."));
    expect(findButton(/^Retry$/)).toBeNull();
    const listAppsBtn = findButton(/list apps/i);
    expect(listAppsBtn).not.toBeNull();
    flushSync(() => {
      listAppsBtn!.click();
    });
    expect(sendMessage).toHaveBeenCalledWith("What's running?");
    expect(retrySkuTiers).not.toHaveBeenCalled();
  });

  it('does not match unrelated error text', () => {
    render(makeError('Some unrelated tool failure happened.'));
    expect(findButton(/^Retry$/)).toBeNull();
  });

  it('does not match a long sentence that merely contains "Deploy unavailable" in the middle', () => {
    // The tier-rejection patterns are anchored at the start of the string;
    // a random tool-error mention of "deploy unavailable" mid-sentence should
    // not steal a Retry button.
    render(makeError('Something broke. Deploy unavailable for unrelated reasons. Try later.'));
    expect(findButton(/^Retry$/)).toBeNull();
  });

  it('logs but does not throw when retrySkuTiers rejects', async () => {
    retrySkuTiers.mockRejectedValueOnce(new Error('boom'));
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(makeError('Deploy unavailable: chain unreachable.'));
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
