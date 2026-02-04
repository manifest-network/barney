import { useState, useCallback, useMemo } from 'react';

export interface UseBatchSelectionReturn {
  selected: Set<string>;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
  has: (id: string) => boolean;
  count: number;
}

/**
 * Manages a set of selected item IDs for batch operations.
 */
export function useBatchSelection(): UseBatchSelectionReturn {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const has = useCallback((id: string) => selected.has(id), [selected]);

  return useMemo(
    () => ({ selected, toggle, selectAll, clear, has, count: selected.size }),
    [selected, toggle, selectAll, clear, has],
  );
}
