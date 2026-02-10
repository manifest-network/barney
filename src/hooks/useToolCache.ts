/**
 * Tool result cache hook — caches query tool results to reduce redundant API calls.
 * Cache is scoped per wallet address and cleared on wallet change.
 */

import { useCallback, useRef } from 'react';
import type { ToolResult } from '../ai/toolExecutor';
import { AI_TOOL_CACHE_TTL_MS, AI_TOOL_CACHE_MAX_SIZE } from '../config/constants';

export function useToolCache(
  addressRef: React.MutableRefObject<string | undefined>
) {
  const toolCacheRef = useRef<Map<string, { result: ToolResult; timestamp: number }>>(new Map());

  // Generate cache key for tool calls (includes address to prevent cross-wallet stale hits)
  const getToolCacheKey = useCallback((toolName: string, args: Record<string, unknown>): string => {
    const addr = addressRef.current ?? '';
    // Sort keys for consistent cache key regardless of arg order
    const sortedArgs = Object.keys(args).sort().reduce((acc, key) => {
      acc[key] = args[key];
      return acc;
    }, {} as Record<string, unknown>);
    return `${addr}:${toolName}:${JSON.stringify(sortedArgs)}`;
  }, [addressRef]);

  // Check if cached result is still valid
  const getCachedToolResult = useCallback((cacheKey: string): ToolResult | null => {
    const cached = toolCacheRef.current.get(cacheKey);
    if (!cached) return null;

    const isExpired = Date.now() - cached.timestamp > AI_TOOL_CACHE_TTL_MS;
    if (isExpired) {
      toolCacheRef.current.delete(cacheKey);
      return null;
    }

    return cached.result;
  }, []);

  // Store a result in the cache with eviction
  const cacheToolResult = useCallback((cacheKey: string, result: ToolResult) => {
    // Evict oldest entries if cache is full
    if (toolCacheRef.current.size >= AI_TOOL_CACHE_MAX_SIZE) {
      const entries = Array.from(toolCacheRef.current.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      // Remove oldest 10% of entries
      const toRemove = Math.max(1, Math.floor(AI_TOOL_CACHE_MAX_SIZE * 0.1));
      for (let i = 0; i < toRemove; i++) {
        toolCacheRef.current.delete(entries[i][0]);
      }
    }
    toolCacheRef.current.set(cacheKey, { result, timestamp: Date.now() });
  }, []);

  const clearCache = useCallback(() => {
    toolCacheRef.current.clear();
  }, []);

  return { getToolCacheKey, getCachedToolResult, cacheToolResult, clearCache };
}
