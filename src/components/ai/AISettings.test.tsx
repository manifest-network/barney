import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const clearHistory = vi.fn();
const updateSettings = vi.fn();
let aiState: {
  settings: { saveHistory: boolean };
  messages: Array<{ id: string }>;
  isStreaming: boolean;
};

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({
    settings: aiState.settings,
    updateSettings,
    clearHistory,
    messages: aiState.messages,
    isStreaming: aiState.isStreaming,
  }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

import { AISettings } from './AISettings';

describe('AISettings clear-history gate', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    aiState = {
      settings: { saveHistory: true },
      messages: [{ id: 'm1' }],
      isStreaming: false,
    };
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  function render(): void {
    act(() => { root.render(createElement(AISettings, { onClose: vi.fn() })); });
  }

  function clearButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes("Clear This Wallet's History")) as
        HTMLButtonElement | undefined;
  }

  it('offers the clear action when nothing is in flight', () => {
    render();
    expect(clearButton()?.disabled).toBe(false);
  });

  it('disables the clear action while work is in flight', () => {
    // Clearing is a cancellation boundary. `isStreaming` is true both for a
    // chat stream and for a confirmed transaction that has already broadcast,
    // where cancelling would strand a paid lease. ChatPanel applies the same
    // gate to `/clear`; the two entry points must not disagree.
    aiState.isStreaming = true;
    render();

    expect(clearButton()?.disabled).toBe(true);
  });

  it('does not clear even if the disabled control is activated', () => {
    aiState.isStreaming = true;
    render();

    act(() => { clearButton()?.click(); });

    expect(clearHistory).not.toHaveBeenCalled();
    // The confirm step must not be armed either.
    expect(container.textContent).not.toContain('Confirm?');
  });

  it('still requires a second click to confirm when idle', () => {
    render();

    act(() => { clearButton()?.click(); });
    expect(clearHistory).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Confirm')) as HTMLButtonElement | undefined;
    expect(confirm).toBeDefined();
    act(() => { confirm?.click(); });

    expect(clearHistory).toHaveBeenCalledOnce();
  });

  it('disables the clear action when there is nothing to clear', () => {
    aiState.messages = [];
    render();

    expect(clearButton()?.disabled).toBe(true);
  });
});
