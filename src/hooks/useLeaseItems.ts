import { useState, useCallback } from 'react';
import type { LeaseItemInput } from '../api/tx';

/** Lease item with a unique ID for React key stability. */
export interface LeaseItemWithId extends LeaseItemInput {
  id: string;
}

function createItem(): LeaseItemWithId {
  return {
    id: crypto.randomUUID(),
    skuUuid: '',
    quantity: 1,
  };
}

/**
 * Custom hook for managing lease item state in forms.
 * Provides add, remove, update, and reset operations for a list of SKU items.
 * Each item has a unique `id` for stable React keys.
 */
export function useLeaseItems() {
  const [items, setItems] = useState<LeaseItemWithId[]>(() => [createItem()]);

  const addItem = useCallback(() => {
    setItems((prev) => [...prev, createItem()]);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const updateItem = useCallback((id: string, field: keyof LeaseItemInput, value: string | number) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  }, []);

  const resetItems = useCallback(() => {
    setItems([createItem()]);
  }, []);

  /** Get valid items without IDs for API submission. Filters out incomplete entries. */
  const getItemsForSubmit = useCallback((): LeaseItemInput[] => {
    return items
      .filter((item) => item.skuUuid && item.quantity > 0)
      .map(({ skuUuid, quantity }) => ({ skuUuid, quantity }));
  }, [items]);

  return { items, addItem, removeItem, updateItem, resetItems, getItemsForSubmit };
}
