import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createAIStore, type AIStore } from '../stores/aiStore';
import type { PendingConfirmation } from '../contexts/aiTypes';
import { AIStoreContext } from '../contexts/aiStoreContext';
import { useAI } from './useAI';
import { ConfirmationCard } from '../components/ai/ConfirmationCard';

vi.mock('../api/morpheus', () => ({
  streamChat: vi.fn(),
  checkApiHealth: vi.fn().mockResolvedValue(false),
}));

vi.mock('../ai/toolExecutor', () => ({
  executeConfirmedTool: vi.fn(),
}));

vi.mock('../ai/streamUtils', () => ({
  processStreamWithTimeout: vi.fn(),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { executeConfirmedTool } from '../ai/toolExecutor';

function RenderedConfirmationFlow() {
  const { pendingConfirmation, confirmAction, cancelAction, isStreaming, messages } = useAI();
  if (!pendingConfirmation) {
    return createElement('div', { 'data-testid': 'cancelled' }, messages.at(-1)?.content ?? 'No confirmation');
  }
  return createElement(ConfirmationCard, {
    action: pendingConfirmation.action,
    onConfirm: (overrides) => { void confirmAction(overrides); },
    onCancel: cancelAction,
    isExecuting: isStreaming,
  });
}

describe('confirmation flow (Zustand store)', () => {
  let store: ReturnType<typeof createAIStore>;
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store = createAIStore();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    store.getState().destroy();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  it('cancelAction clears deploy progress', () => {
    const pending: PendingConfirmation = {
      id: 'pending-1',
      messageId: 'msg-1',
      action: {
        originAddress: 'manifest1test',
        chainId: store.getState().chainId,
        clientGeneration: 0,
        signerGeneration: 0,
        id: 'action-1',
        toolName: 'deploy_app',
        args: { app_name: 'test' },
        description: 'Deploy test?',
      },
    };

    // Add a message that the cancel will update
    store.getState().addMessage({
      id: 'msg-1',
      role: 'tool',
      content: 'Deploying...',
      timestamp: Date.now(),
      isStreaming: true,
    });

    store.setState({
      pendingConfirmation: pending,
      deployProgress: { phase: 'creating_lease', operation: 'deploy' },
    });

    store.getState().cancelAction();

    expect(store.getState().deployProgress).toBeNull();
    expect(store.getState().pendingConfirmation).toBeNull();
    expect(store.getState().pendingPayload).toBeNull();

    // Message should be updated
    const msg = store.getState().messages.find((m) => m.id === 'msg-1');
    expect(msg?.content).toBe('Action cancelled by user.');
    expect(msg?.isStreaming).toBe(false);
  });

  it('cancelAction is a no-op when no pending confirmation', () => {
    store.setState({ deployProgress: { phase: 'creating_lease', operation: 'deploy' } });
    store.getState().cancelAction();
    // deployProgress should NOT be cleared since there's no pending confirmation
    expect(store.getState().deployProgress).not.toBeNull();
  });

  it('rendered consent from wallet A disappears and cannot be approved by wallet B', async () => {
    const toolName = 'fund_credits';
    const managerA = { wallet: 'a' } as unknown as NonNullable<AIStore['clientManager']>;
    const managerB = { wallet: 'b' } as unknown as NonNullable<AIStore['clientManager']>;
    const signerA = { wallet: 'a' } as unknown as NonNullable<AIStore['signing']>;
    const signerB = { wallet: 'b' } as unknown as NonNullable<AIStore['signing']>;
    store.getState().setWalletContext({
      clientManager: managerA,
      address: 'manifest1walleta',
      signing: signerA,
      chainId: 'manifest-test',
    });
    const identity = store.getState();
    const stalePending: PendingConfirmation = {
      id: 'pending-a',
      messageId: 'tool-consent',
      action: Object.freeze({
        originAddress: 'manifest1walleta',
        chainId: identity.chainId,
        clientGeneration: identity.clientGeneration,
        signerGeneration: identity.signerGeneration,
        id: 'action-a',
        toolName,
        args: { address: 'manifest1walleta', amount: 5, denomString: '5000000upwr' },
        description: `Confirm ${toolName}?`,
      }),
    };
    store.setState({
      messages: [{
        id: 'tool-consent', role: 'tool', content: 'Confirm transaction?', timestamp: 1,
        toolName, isStreaming: false, awaitingConfirmation: true,
      }],
      pendingConfirmation: stalePending,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(
        AIStoreContext.Provider,
        { value: store },
        createElement(RenderedConfirmationFlow),
      ));
    });
    expect(Array.from(container.querySelectorAll('button')).some(
      (button) => button.textContent?.includes('Confirm'),
    )).toBe(true);

    await act(async () => {
      store.getState().setWalletContext({
        clientManager: managerB,
        address: 'manifest1walletb',
        signing: signerB,
        chainId: 'manifest-test',
      });
    });

    expect(store.getState().pendingConfirmation).toBeNull();
    expect(container.querySelector('[data-testid="cancelled"]')?.textContent)
      .toContain('cancelled and was not submitted');
    expect(Array.from(container.querySelectorAll('button')).some(
      (button) => button.textContent?.includes('Confirm'),
    )).toBe(false);

    // Adversarial race: restore the stale A consent without using the atomic
    // context API, then click the real rendered Confirm button as wallet B.
    // The confirm-time authorization check must still fail closed.
    await act(async () => {
      store.setState({ pendingConfirmation: stalePending });
    });
    const staleConfirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Confirm'),
    );
    expect(staleConfirmButton).toBeDefined();
    await act(async () => {
      staleConfirmButton?.click();
      await Promise.resolve();
    });

    expect(store.getState().pendingConfirmation).toBeNull();
    expect(store.getState().messages.find((message) => message.id === 'tool-consent')?.content)
      .toContain('cancelled and was not submitted');
    expect(executeConfirmedTool).not.toHaveBeenCalled();
  });
});
