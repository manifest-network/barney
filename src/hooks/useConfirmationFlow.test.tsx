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

vi.mock('../utils/customDomainValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/customDomainValidation')>();
  return {
    ...actual,
    validateAll: vi.fn().mockResolvedValue({}),
  };
});

import { executeConfirmedTool } from '../ai/toolExecutor';
import { validateAll } from '../utils/customDomainValidation';

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
    vi.mocked(validateAll).mockReset();
    vi.mocked(validateAll).mockResolvedValue({});
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

  it.each([
    {
      caseName: 'fund_credits',
      toolName: 'fund_credits',
      args: { address: 'manifest1walleta', amount: 5, denomString: '5000000upwr' },
      rendersDeployEditor: false,
      expectsNonDeployManifestOverride: false,
      domainValidation: 'none',
      expectedGate: 'wallet',
    },
    {
      caseName: 'deploy_app with a valid domain',
      toolName: 'deploy_app',
      args: {
        app_name: 'web',
        size: 'micro',
        customDomain: 'web.example.com',
        _generatedManifest: JSON.stringify({
          image: 'nginx:alpine',
          ports: { '80/tcp': { ingress: true } },
        }),
      },
      rendersDeployEditor: true,
      expectsNonDeployManifestOverride: false,
      domainValidation: 'valid',
      expectedGate: 'wallet',
    },
    {
      caseName: 'deploy_app with a domain validation error',
      toolName: 'deploy_app',
      args: {
        app_name: 'web',
        size: 'micro',
        customDomain: 'reserved.example.com',
        _generatedManifest: JSON.stringify({
          image: 'nginx:alpine',
          ports: { '80/tcp': { ingress: true } },
        }),
      },
      rendersDeployEditor: true,
      expectsNonDeployManifestOverride: false,
      domainValidation: 'async_error',
      expectedGate: 'domain',
    },
    {
      caseName: 'stop_app',
      toolName: 'stop_app',
      args: {
        app_name: 'web',
        leaseUuid: 'lease-web',
      },
      rendersDeployEditor: false,
      expectsNonDeployManifestOverride: false,
      domainValidation: 'none',
      expectedGate: 'wallet',
    },
    {
      caseName: 'update_app',
      // This uniquely drives ConfirmationCard's non-deploy handleConfirm arm
      // with a manifest override present.
      toolName: 'update_app',
      args: {
        app_name: 'web',
        leaseUuid: 'lease-web',
        providerUrl: 'https://fred.example.com',
        _generatedManifest: JSON.stringify({
          image: 'nginx:stable',
          ports: { '80/tcp': { ingress: true } },
        }),
      },
      rendersDeployEditor: true,
      expectsNonDeployManifestOverride: true,
      domainValidation: 'none',
      expectedGate: 'wallet',
    },
  ] as const)('rendered $caseName restored consent fails closed at the $expectedGate gate', async ({
    toolName,
    args,
    rendersDeployEditor,
    expectsNonDeployManifestOverride,
    domainValidation,
  }) => {
    if (domainValidation === 'async_error') {
      vi.mocked(validateAll).mockResolvedValue({ error: 'This domain is reserved.' });
    }
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
        args,
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
    const originalConfirmAction = store.getState().confirmAction;
    const confirmActionSpy = vi.fn((overrides?: Parameters<typeof originalConfirmAction>[0]) =>
      originalConfirmAction(overrides)
    );
    store.setState({ confirmAction: confirmActionSpy });

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
    const initialConfirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Confirm'),
    );
    expect(initialConfirmButton).toBeDefined();
    if (domainValidation !== 'none') {
      expect(initialConfirmButton?.disabled).toBe(true);
    }
    expect(container.querySelector('[data-testid="manifest-editor"]') !== null)
      .toBe(rendersDeployEditor);

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
    let staleConfirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Confirm'),
    );
    expect(staleConfirmButton).toBeDefined();
    expect(container.querySelector('[data-testid="manifest-editor"]') !== null)
      .toBe(rendersDeployEditor);
    if (domainValidation !== 'none') {
      // The restored stale consent must remain gated while the domain check is
      // pending. A valid domain then reaches the stale-wallet store guard; an
      // invalid one stays blocked in the rendered confirmation surface.
      expect(staleConfirmButton?.disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      staleConfirmButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Confirm'),
      );
      expect(staleConfirmButton?.disabled).toBe(domainValidation === 'async_error');
    }
    if (domainValidation === 'async_error') {
      expect(container.textContent).toContain('This domain is reserved.');
      await act(async () => {
        staleConfirmButton?.click();
      });
      expect(confirmActionSpy).not.toHaveBeenCalled();
      expect(store.getState().pendingConfirmation).toBe(stalePending);
      return;
    }
    const executionTransitions: Array<Pick<AIStore,
      'isStreaming' | 'abortController' | 'activeTransactionMessageId' | 'messages'>> = [];
    const unsubscribe = store.subscribe((state) => {
      executionTransitions.push({
        isStreaming: state.isStreaming,
        abortController: state.abortController,
        activeTransactionMessageId: state.activeTransactionMessageId,
        messages: state.messages,
      });
    });
    await act(async () => {
      staleConfirmButton?.click();
      await Promise.resolve();
    });
    unsubscribe();

    expect(store.getState().pendingConfirmation).toBeNull();
    expect(store.getState().messages.find((message) => message.id === 'tool-consent')?.content)
      .toContain('cancelled and was not submitted');
    expect(executeConfirmedTool).not.toHaveBeenCalled();
    if (expectsNonDeployManifestOverride) {
      const override = confirmActionSpy.mock.calls.at(-1)?.[0];
      expect(override?.editedManifestJson).toBeDefined();
      expect(JSON.parse(override?.editedManifestJson ?? '{}')).toEqual(
        JSON.parse('_generatedManifest' in args ? args._generatedManifest : '{}'),
      );
    }
    if (domainValidation === 'valid') {
      // This row has cleared the domain gate, so the call proves that a valid
      // edited domain reaches the confirm-time stale-wallet authorization guard.
      expect(confirmActionSpy).toHaveBeenCalledOnce();
      expect(confirmActionSpy).toHaveBeenCalledWith(expect.objectContaining({
        editedCustomDomain: 'web.example.com',
      }));
    }
    expect(executionTransitions.length).toBeGreaterThan(0);
    expect(executionTransitions.every((state) =>
      state.isStreaming === false
      && state.abortController === null
      && state.activeTransactionMessageId === null
      && state.messages.every((message) => message.transactionInFlight !== true)
    )).toBe(true);
  });
});
