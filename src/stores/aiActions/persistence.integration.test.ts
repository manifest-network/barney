/**
 * Integration test: PersistedMessageSchema + rehydrateChatHistory round-trip.
 *
 * `persistence.test.ts` mocks `validateChatHistory` as a passthrough — useful
 * for testing the rehydrate logic in isolation, but it can't catch a schema
 * strip-unknown-keys regression. This file imports the REAL validation module
 * so the full localStorage → schema → rehydrate path is exercised.
 *
 * If you find yourself adding a new transient flag to ChatMessage, also
 * whitelist it in `PersistedMessageSchema` and add a row here so the
 * round-trip stays covered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadHistory } from './persistence';

const STORAGE_KEY_HISTORY = 'barney-ai-history';

describe('persistence integration with real PersistedMessageSchema', () => {
  beforeEach(() => { localStorage.clear(); });

  it('round-trips awaitingConfirmation through schema and into rehydrate marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'tool',
      content: 'Deploy "redis" on micro tier?',
      timestamp: 1,
      toolCallId: 'tc1',
      toolName: 'deploy_app',
      awaitingConfirmation: true,
    }];
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(persisted));
    const result = loadHistory();
    expect(result).toHaveLength(1);
    expect(result[0].error).toBe('Interrupted');
    expect(result[0].content).toBe('Interrupted — confirmation was pending when the page reloaded.');
    expect(result[0].awaitingConfirmation).toBe(false);
  });

  it('round-trips isStreaming=true into the interrupted-stream rehydrate branch', () => {
    const persisted = [{
      id: 'm1',
      role: 'assistant',
      content: 'half-streamed...',
      timestamp: 1,
      isStreaming: true,
    }];
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(persisted));
    const result = loadHistory();
    expect(result).toHaveLength(1);
    expect(result[0].isStreaming).toBe(false);
    expect(result[0].error).toMatch(/Interrupted — message was incomplete/);
  });

  it('round-trips local=true so synthesized messages keep the filter marker', () => {
    const persisted = [{
      id: 'm1',
      role: 'assistant',
      content: '/help canned text',
      timestamp: 1,
      local: true,
    }];
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(persisted));
    const result = loadHistory();
    expect(result).toHaveLength(1);
    expect(result[0].local).toBe(true);
  });
});
