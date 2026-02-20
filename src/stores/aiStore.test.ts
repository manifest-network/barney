import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoreApi } from 'zustand';

// --- Mocks ---

vi.mock('../api/ollama', () => ({
  checkOllamaHealth: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue([{ name: 'llama3.2' }]),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../utils/fileValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fileValidation')>();
  return {
    ...actual,
    validateFile: vi.fn().mockReturnValue({ valid: true }),
  };
});

vi.mock('../utils/hash', () => ({
  sha256: vi.fn().mockResolvedValue(new Uint8Array([0xab, 0xcd])),
  toHex: vi.fn().mockReturnValue('abcd'),
  MAX_PAYLOAD_SIZE: 5120,
}));

vi.mock('../ai/validation', () => ({
  validateEndpointUrl: vi.fn((url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return null;
  }),
  validateSettings: vi.fn((data: unknown) => data),
  validateChatHistory: vi.fn((data: unknown) => data),
  sanitizeToolArgs: vi.fn((args: unknown) => args),
}));

vi.mock('../config/runtimeConfig', () => ({
  runtimeConfig: {
    PUBLIC_OLLAMA_URL: 'http://localhost:11434',
    PUBLIC_OLLAMA_MODEL: 'llama3.2',
  },
}));

// Mock streaming, persistence, sendMessage, confirmAction, batchDeploy
vi.mock('./aiActions/persistence', () => ({
  loadSettings: vi.fn().mockReturnValue({
    ollamaEndpoint: 'http://localhost:11434',
    model: 'llama3.2',
    saveHistory: true,
    enableThinking: false,
  }),
  loadHistory: vi.fn().mockReturnValue([]),
  clearHistoryStorage: vi.fn(),
  saveSettings: vi.fn(),
  saveHistory: vi.fn(),
}));

vi.mock('./aiActions/streaming', () => ({
  scheduleStreamingUpdateFn: vi.fn(),
  flushPendingUpdateFn: vi.fn(),
}));

vi.mock('./aiActions/sendMessage', () => ({
  sendMessageFn: vi.fn(),
}));

vi.mock('./aiActions/confirmAction', () => ({
  confirmActionFn: vi.fn(),
  cancelActionFn: vi.fn(),
}));

vi.mock('./aiActions/batchDeploy', () => ({
  requestBatchDeployFn: vi.fn(),
}));

// Now import
import { createAIStore, type AIStore } from './aiStore';
import { listModels } from '../api/ollama';
import { logError } from '../utils/errors';
import { validateFile } from '../utils/fileValidation';
import { clearHistoryStorage } from './aiActions/persistence';

type Store = StoreApi<AIStore>;

function makeMessage(overrides: Partial<AIStore['messages'][0]> = {}): AIStore['messages'][0] {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('aiStore', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    store = createAIStore();
  });

  afterEach(() => {
    store.getState().destroy();
  });

  // ---- Simple actions ----

  describe('addMessage', () => {
    it('appends a message to the list', () => {
      const msg = makeMessage();
      store.getState().addMessage(msg);
      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().messages[0]).toBe(msg);
    });

    it('preserves existing messages', () => {
      const m1 = makeMessage({ content: 'first' });
      const m2 = makeMessage({ content: 'second' });
      store.getState().addMessage(m1);
      store.getState().addMessage(m2);
      expect(store.getState().messages).toHaveLength(2);
      expect(store.getState().messages[0].content).toBe('first');
      expect(store.getState().messages[1].content).toBe('second');
    });
  });

  describe('updateMessageById', () => {
    it('patches a message by id', () => {
      const msg = makeMessage({ id: 'target', content: 'old' });
      store.getState().addMessage(msg);
      store.getState().updateMessageById('target', { content: 'new' });
      expect(store.getState().messages[0].content).toBe('new');
    });

    it('is a no-op for a missing id', () => {
      const msg = makeMessage({ content: 'original' });
      store.getState().addMessage(msg);
      store.getState().updateMessageById('nonexistent', { content: 'changed' });
      expect(store.getState().messages[0].content).toBe('original');
    });
  });

  describe('getCurrentMessages', () => {
    it('returns all messages when no excludeId', () => {
      const m1 = makeMessage({ id: 'a' });
      const m2 = makeMessage({ id: 'b' });
      store.getState().addMessage(m1);
      store.getState().addMessage(m2);
      expect(store.getState().getCurrentMessages()).toHaveLength(2);
    });

    it('filters out the excluded id', () => {
      const m1 = makeMessage({ id: 'a' });
      const m2 = makeMessage({ id: 'b' });
      store.getState().addMessage(m1);
      store.getState().addMessage(m2);
      const result = store.getState().getCurrentMessages('a');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('b');
    });
  });

  describe('addLocalMessage', () => {
    it('creates an assistant message with content', () => {
      store.getState().addLocalMessage('Hi there');
      const msgs = store.getState().messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('assistant');
      expect(msgs[0].content).toBe('Hi there');
    });

    it('includes a card if provided', () => {
      store.getState().addLocalMessage('card msg', { type: 'help', data: null });
      const msgs = store.getState().messages;
      expect(msgs[0].card).toEqual({ type: 'help', data: null });
    });
  });

  describe('setIsOpen', () => {
    it('toggles isOpen', () => {
      expect(store.getState().isOpen).toBe(false);
      store.getState().setIsOpen(true);
      expect(store.getState().isOpen).toBe(true);
      store.getState().setIsOpen(false);
      expect(store.getState().isOpen).toBe(false);
    });
  });

  describe('stopStreaming', () => {
    it('calls abort on the controller', () => {
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      store.setState({ abortController: controller });
      store.getState().stopStreaming();
      expect(abortSpy).toHaveBeenCalled();
    });

    it('is a no-op when no controller exists', () => {
      expect(() => store.getState().stopStreaming()).not.toThrow();
    });
  });

  // ---- Wallet setters ----

  describe('setAddress', () => {
    it('clears tool cache and deployProgress on change', () => {
      store.getState().cacheToolResult('key1', { success: true, data: 'x' });
      store.setState({ deployProgress: { phase: 'ready' } as AIStore['deployProgress'] });
      store.getState().setAddress('manifest1abc');
      expect(store.getState()._toolCache.size).toBe(0);
      expect(store.getState().deployProgress).toBeNull();
    });

    it('does not clear cache if address is unchanged', () => {
      store.getState().setAddress('manifest1abc');
      store.getState().cacheToolResult('key1', { success: true, data: 'x' });
      store.getState().setAddress('manifest1abc');
      expect(store.getState()._toolCache.size).toBe(1);
    });
  });

  describe('setClientManager', () => {
    it('stores the client manager', () => {
      const mgr = {} as AIStore['clientManager'];
      store.getState().setClientManager(mgr);
      expect(store.getState().clientManager).toBe(mgr);
    });
  });

  describe('setSignArbitrary', () => {
    it('stores the signArbitrary fn', () => {
      const fn = vi.fn();
      store.getState().setSignArbitrary(fn);
      expect(store.getState().signArbitrary).toBe(fn);
    });
  });

  // ---- Settings ----

  describe('updateSettings', () => {
    it('accepts a valid endpoint', () => {
      store.getState().updateSettings({ ollamaEndpoint: 'http://example.com:11434' });
      expect(store.getState().settings.ollamaEndpoint).toBe('http://example.com:11434');
    });

    it('rejects an invalid endpoint', () => {
      const original = store.getState().settings.ollamaEndpoint;
      store.getState().updateSettings({ ollamaEndpoint: 'not-a-url' });
      expect(store.getState().settings.ollamaEndpoint).toBe(original);
    });

    it('accepts a valid model string', () => {
      store.getState().updateSettings({ model: 'qwen2.5' });
      expect(store.getState().settings.model).toBe('qwen2.5');
    });

    it('rejects an empty model string', () => {
      const original = store.getState().settings.model;
      store.getState().updateSettings({ model: '' });
      expect(store.getState().settings.model).toBe(original);
    });

    it('accepts boolean settings', () => {
      store.getState().updateSettings({ saveHistory: false, enableThinking: true });
      expect(store.getState().settings.saveHistory).toBe(false);
      expect(store.getState().settings.enableThinking).toBe(true);
    });
  });

  // ---- History ----

  describe('clearHistory', () => {
    it('clears messages, tool cache, and localStorage', () => {
      store.getState().addMessage(makeMessage());
      store.getState().cacheToolResult('k', { success: true, data: 1 });
      store.getState().clearHistory();
      expect(store.getState().messages).toHaveLength(0);
      expect(store.getState()._toolCache.size).toBe(0);
      expect(clearHistoryStorage).toHaveBeenCalled();
    });
  });

  // ---- attachPayload ----

  describe('attachPayload', () => {
    it('returns error when validation fails', async () => {
      vi.mocked(validateFile).mockReturnValueOnce({ valid: false, error: 'bad file' });
      const file = new File(['x'], 'test.txt', { type: 'text/plain' });
      const result = await store.getState().attachPayload(file);
      expect(result.error).toBe('bad file');
      expect(store.getState().pendingPayload).toBeNull();
    });

    it('rejects invalid manifest content', async () => {
      const file = new File(['hello'], 'test.json', { type: 'application/json' });
      const result = await store.getState().attachPayload(file);
      expect(result.error).toContain('Invalid JSON');
      expect(store.getState().pendingPayload).toBeNull();
    });

    it('attaches payload on success', async () => {
      const file = new File([JSON.stringify({ image: 'redis:8' })], 'test.json', { type: 'application/json' });
      const result = await store.getState().attachPayload(file);
      expect(result.error).toBeUndefined();
      expect(store.getState().pendingPayload).not.toBeNull();
      expect(store.getState().pendingPayload!.filename).toBe('test.json');
      expect(store.getState().pendingPayload!.hash).toBe('abcd');
    });

    it('returns error on file read failure', async () => {
      const badFile = {
        name: 'test.json',
        size: 10,
        type: 'application/json',
        arrayBuffer: () => Promise.reject(new Error('read error')),
      } as unknown as File;
      const result = await store.getState().attachPayload(badFile);
      expect(result.error).toBe('Failed to read file');
      expect(logError).toHaveBeenCalled();
    });
  });

  // ---- refreshModels ----

  describe('refreshModels', () => {
    it('populates availableModels on success', async () => {
      vi.mocked(listModels).mockResolvedValueOnce([
        { name: 'model-a' } as AIStore['availableModels'][0],
      ]);
      await store.getState().refreshModels();
      expect(store.getState().availableModels).toHaveLength(1);
      expect(store.getState().availableModels[0].name).toBe('model-a');
    });

    it('logs error and keeps models unchanged on failure', async () => {
      vi.mocked(listModels).mockRejectedValueOnce(new Error('network'));
      await store.getState().refreshModels();
      expect(store.getState().availableModels).toHaveLength(0);
      expect(logError).toHaveBeenCalledWith('aiStore.refreshModels', expect.any(Error));
    });
  });

  // ---- Tool cache ----

  describe('tool cache', () => {
    it('generates keys that include address', () => {
      store.getState().setAddress('addr1');
      const key = store.getState().getToolCacheKey('list_apps', { state: 'running' });
      expect(key).toContain('addr1');
      expect(key).toContain('list_apps');
    });

    it('generates keys with sorted args', () => {
      const k1 = store.getState().getToolCacheKey('t', { b: 2, a: 1 });
      const k2 = store.getState().getToolCacheKey('t', { a: 1, b: 2 });
      expect(k1).toBe(k2);
    });

    it('returns null for missing key', () => {
      expect(store.getState().getCachedToolResult('missing')).toBeNull();
    });

    it('caches and retrieves a result', () => {
      const result = { success: true as const, data: 'hello' };
      store.getState().cacheToolResult('k1', result);
      expect(store.getState().getCachedToolResult('k1')).toEqual(result);
    });

    it('returns null after TTL expires', () => {
      vi.useFakeTimers();
      const result = { success: true as const, data: 'x' };
      store.getState().cacheToolResult('k1', result);
      vi.advanceTimersByTime(11_000); // > 10s TTL
      expect(store.getState().getCachedToolResult('k1')).toBeNull();
      vi.useRealTimers();
    });

    it('evicts oldest entries when at capacity', () => {
      vi.useFakeTimers();
      // Fill to capacity
      for (let i = 0; i < 50; i++) {
        vi.advanceTimersByTime(1); // ensure unique timestamps
        store.getState().cacheToolResult(`key${i}`, { success: true, data: i });
      }
      expect(store.getState()._toolCache.size).toBe(50);

      // Adding one more triggers eviction
      store.getState().cacheToolResult('overflow', { success: true, data: 'new' });
      // Eviction removes 10% (5 entries), then adds 1 new = 46
      expect(store.getState()._toolCache.size).toBe(46);
      // Oldest 5 entries (key0–key4) should be evicted
      expect(store.getState().getCachedToolResult('key0')).toBeNull();
      expect(store.getState().getCachedToolResult('key4')).toBeNull();
      // key5 should survive
      expect(store.getState().getCachedToolResult('key5')).not.toBeNull();
      // New entry should exist
      expect(store.getState().getCachedToolResult('overflow')).not.toBeNull();
      vi.useRealTimers();
    });

    it('clearToolCache empties the cache', () => {
      store.getState().cacheToolResult('k', { success: true, data: 1 });
      store.getState().clearToolCache();
      expect(store.getState()._toolCache.size).toBe(0);
    });
  });

  // ---- Lifecycle ----

  describe('destroy', () => {
    it('aborts controller and clears raf', () => {
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      store.setState({ abortController: controller, _rafId: 42 });
      const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      store.getState().destroy();
      expect(abortSpy).toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalledWith(42);
      expect(store.getState()._rafId).toBeNull();
      expect(store.getState().abortController).toBeNull();
      cancelSpy.mockRestore();
    });
  });
});
