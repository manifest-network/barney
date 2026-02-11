import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AI_TOOL_CACHE_TTL_MS, AI_TOOL_CACHE_MAX_SIZE } from '../config/constants';
import type { ToolResult } from '../ai/toolExecutor';

/**
 * Tests for useToolCache logic, extracted to avoid @testing-library/react dependency.
 * The hook uses refs (not state), so the core logic is testable without React rendering.
 */

const SUCCESS_RESULT: ToolResult = { success: true, data: { balance: '100' } };
const OTHER_RESULT: ToolResult = { success: true, data: { apps: [] } };

// Extracted cache key logic (mirrors useToolCache.getToolCacheKey)
function getToolCacheKey(address: string | undefined, toolName: string, args: Record<string, unknown>): string {
  const addr = address ?? '';
  const sortedArgs = Object.keys(args).sort().reduce((acc, key) => {
    acc[key] = args[key];
    return acc;
  }, {} as Record<string, unknown>);
  return `${addr}:${toolName}:${JSON.stringify(sortedArgs)}`;
}

// Simulates the cache behavior using a plain Map (same as the hook's ref)
class ToolCache {
  private cache = new Map<string, { result: ToolResult; timestamp: number }>();

  get(key: string): ToolResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > AI_TOOL_CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return cached.result;
  }

  set(key: string, result: ToolResult): void {
    if (this.cache.size >= AI_TOOL_CACHE_MAX_SIZE) {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = Math.max(1, Math.floor(AI_TOOL_CACHE_MAX_SIZE * 0.1));
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

describe('getToolCacheKey', () => {
  it('includes address in cache key', () => {
    const key = getToolCacheKey('manifest1abc', 'list_apps', {});
    expect(key).toContain('manifest1abc');
  });

  it('uses empty string for undefined address', () => {
    const key = getToolCacheKey(undefined, 'list_apps', {});
    expect(key.startsWith(':')).toBe(true);
  });

  it('generates different keys for different tools', () => {
    const key1 = getToolCacheKey('addr', 'list_apps', {});
    const key2 = getToolCacheKey('addr', 'get_balance', {});
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different args', () => {
    const key1 = getToolCacheKey('addr', 'list_apps', { state: 'running' });
    const key2 = getToolCacheKey('addr', 'list_apps', { state: 'stopped' });
    expect(key1).not.toBe(key2);
  });

  it('generates same key regardless of arg order', () => {
    const key1 = getToolCacheKey('addr', 'tool', { a: '1', b: '2' });
    const key2 = getToolCacheKey('addr', 'tool', { b: '2', a: '1' });
    expect(key1).toBe(key2);
  });

  it('generates different keys for different addresses', () => {
    const key1 = getToolCacheKey('wallet-a', 'list_apps', {});
    const key2 = getToolCacheKey('wallet-b', 'list_apps', {});
    expect(key1).not.toBe(key2);
  });
});

describe('ToolCache', () => {
  let cache: ToolCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ToolCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('returns null for cache miss', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('stores and retrieves a result', () => {
      cache.set('key1', SUCCESS_RESULT);
      expect(cache.get('key1')).toEqual(SUCCESS_RESULT);
    });

    it('stores multiple entries', () => {
      cache.set('key1', SUCCESS_RESULT);
      cache.set('key2', OTHER_RESULT);
      expect(cache.get('key1')).toEqual(SUCCESS_RESULT);
      expect(cache.get('key2')).toEqual(OTHER_RESULT);
    });
  });

  describe('TTL expiration', () => {
    it('expires entries after TTL', () => {
      cache.set('key1', SUCCESS_RESULT);
      vi.advanceTimersByTime(AI_TOOL_CACHE_TTL_MS + 1);
      expect(cache.get('key1')).toBeNull();
    });

    it('returns cached result within TTL', () => {
      cache.set('key1', SUCCESS_RESULT);
      vi.advanceTimersByTime(AI_TOOL_CACHE_TTL_MS - 100);
      expect(cache.get('key1')).toEqual(SUCCESS_RESULT);
    });

    it('each entry has its own TTL', () => {
      cache.set('key1', SUCCESS_RESULT);
      vi.advanceTimersByTime(AI_TOOL_CACHE_TTL_MS / 2);
      cache.set('key2', OTHER_RESULT);
      vi.advanceTimersByTime(AI_TOOL_CACHE_TTL_MS / 2 + 1);

      // key1 should be expired, key2 should still be valid
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toEqual(OTHER_RESULT);
    });
  });

  describe('eviction', () => {
    it('evicts oldest entries when cache is full', () => {
      // Fill cache to max
      for (let i = 0; i < AI_TOOL_CACHE_MAX_SIZE; i++) {
        vi.advanceTimersByTime(1); // Ensure different timestamps
        cache.set(`key-${i}`, SUCCESS_RESULT);
      }
      expect(cache.size).toBe(AI_TOOL_CACHE_MAX_SIZE);

      // Add one more — should trigger eviction of oldest 10%
      cache.set('overflow', OTHER_RESULT);

      // Overflow entry should be present
      expect(cache.get('overflow')).toEqual(OTHER_RESULT);

      // Oldest entries should be evicted (10% of 50 = 5)
      const evicted = Math.max(1, Math.floor(AI_TOOL_CACHE_MAX_SIZE * 0.1));
      for (let i = 0; i < evicted; i++) {
        expect(cache.get(`key-${i}`)).toBeNull();
      }

      // Entry just after the eviction cutoff should still be present
      expect(cache.get(`key-${evicted}`)).toEqual(SUCCESS_RESULT);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      cache.set('key1', SUCCESS_RESULT);
      cache.set('key2', OTHER_RESULT);
      cache.clear();
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.size).toBe(0);
    });
  });
});
