import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIStore } from '../stores/aiStore';
import type { PendingConfirmation } from '../contexts/aiTypes';

vi.mock('../api/ollama', () => ({
  streamChat: vi.fn(),
  checkOllamaHealth: vi.fn().mockResolvedValue(false),
  listModels: vi.fn().mockResolvedValue([]),
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

describe('confirmation flow (Zustand store)', () => {
  let store: ReturnType<typeof createAIStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createAIStore();
  });

  afterEach(() => {
    store.getState().destroy();
    vi.useRealTimers();
  });

  it('cancelAction clears deploy progress', () => {
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
});
