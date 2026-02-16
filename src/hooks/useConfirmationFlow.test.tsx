import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useConfirmationFlow, type UseConfirmationFlowDeps } from './useConfirmationFlow';
import type { PendingConfirmation } from '../contexts/aiTypes';

vi.mock('../api/ollama', () => ({
  streamChat: vi.fn(),
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

// Captures from the test component so tests can drive behavior
const hookResultRef = { current: null as ReturnType<typeof useConfirmationFlow> | null };
let setDeployProgressSpy: ReturnType<typeof vi.fn>;

function TestComponent({ deps }: { deps: Omit<UseConfirmationFlowDeps, 'setDeployProgress'> }) {
  const result = useConfirmationFlow({ ...deps, setDeployProgress: setDeployProgressSpy });
  useEffect(() => { hookResultRef.current = result; });
  return null;
}

function makeDeps(): Omit<UseConfirmationFlowDeps, 'setDeployProgress'> {
  const messagesRef = { current: [] } as UseConfirmationFlowDeps['messagesRef'];
  return {
    isStreamingRef: { current: false },
    abortControllerRef: { current: null },
    clientManagerRef: { current: null },
    addressRef: { current: 'manifest1test' },
    signArbitraryRef: { current: undefined },
    pendingPayloadRef: { current: null },
    setPendingPayload: vi.fn(),
    setIsStreaming: vi.fn(),
    messagesRef,
    setMessages: vi.fn((updater) => {
      if (typeof updater === 'function') {
        messagesRef.current = updater(messagesRef.current);
      }
    }),
    updateMessageById: vi.fn(),
    createAssistantMessage: vi.fn(),
    addMessage: vi.fn(),
    getCurrentMessages: vi.fn(() => []),
    scheduleStreamingUpdate: vi.fn(),
    flushPendingUpdate: vi.fn(),
    settings: { ollamaEndpoint: '', model: '', enableThinking: false } as UseConfirmationFlowDeps['settings'],
    toOllamaMessages: vi.fn(() => []),
    getAppRegistryAccess: vi.fn(() => ({
      getApps: vi.fn(),
      getApp: vi.fn(),
      findApp: vi.fn(),
      getAppByLease: vi.fn(),
      addApp: vi.fn(),
      updateApp: vi.fn(),
    })) as unknown as UseConfirmationFlowDeps['getAppRegistryAccess'],
  };
}

describe('useConfirmationFlow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    setDeployProgressSpy = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('cancelAction clears deploy progress', () => {
    const deps = makeDeps();

    act(() => {
      root.render(createElement(TestComponent, { deps }));
    });

    // Set a pending confirmation
    const pending: PendingConfirmation = {
      id: 'pending-1',
      messageId: 'msg-1',
      action: {
        id: 'action-1',
        toolName: 'deploy_app',
        args: { app_name: 'test' },
        description: 'Deploy test?',
      },
    };

    act(() => {
      hookResultRef.current!.setPendingConfirmation(pending);
    });

    // Cancel the action
    act(() => {
      hookResultRef.current!.cancelAction();
    });

    expect(setDeployProgressSpy).toHaveBeenCalledWith(null);
  });

  it('auto-cancel timeout clears deploy progress', () => {
    const deps = makeDeps();

    act(() => {
      root.render(createElement(TestComponent, { deps }));
    });

    const pending: PendingConfirmation = {
      id: 'pending-2',
      messageId: 'msg-2',
      action: {
        id: 'action-2',
        toolName: 'deploy_app',
        args: { app_name: 'test' },
        description: 'Deploy test?',
      },
    };

    act(() => {
      hookResultRef.current!.setPendingConfirmation(pending);
    });

    // Advance past the confirmation timeout (5 minutes)
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    });

    expect(setDeployProgressSpy).toHaveBeenCalledWith(null);
  });
});
