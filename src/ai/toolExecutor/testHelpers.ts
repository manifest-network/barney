import { vi } from 'vitest';
import type { AppRegistryAccess } from './types';
import type { AppEntry } from '../../registry/appRegistry';

/**
 * Creates a mock AppRegistryAccess that mirrors production findApp precedence/ambiguity logic.
 * Shared across test files to prevent mock drift from production behavior.
 * addApp and updateApp are wrapped with vi.fn() so tests can assert on calls.
 */
export function makeRegistry(apps: AppEntry[] = []): AppRegistryAccess {
  const store = [...apps];
  return {
    getApps: () => [...store],
    getApp: (_addr: string, name: string) => store.find((a) => a.name === name) ?? null,
    findApp: (_addr: string, name: string) => {
      const lower = name.toLowerCase();
      const active = store.filter((a) => a.status === 'running' || a.status === 'deploying');
      // Mirror production precedence with ambiguity checks
      const activeExact = active.find((a) => a.name === lower);
      if (activeExact) return activeExact;
      const activeSuffix = active.filter((a) => a.name.endsWith(`-${lower}`));
      if (activeSuffix.length === 1) return activeSuffix[0];
      const activeSubstring = active.filter((a) => a.name.includes(lower));
      if (activeSubstring.length === 1) return activeSubstring[0];
      if (activeSuffix.length > 1 || activeSubstring.length > 1) return null;
      const anyExact = store.find((a) => a.name === lower);
      if (anyExact) return anyExact;
      const anySuffix = store.filter((a) => a.name.endsWith(`-${lower}`));
      if (anySuffix.length === 1) return anySuffix[0];
      const anySubstring = store.filter((a) => a.name.includes(lower));
      if (anySubstring.length === 1) return anySubstring[0];
      return null;
    },
    getAppByLease: (_addr: string, uuid: string) => store.find((a) => a.leaseUuid === uuid) ?? null,
    addApp: vi.fn((_addr: string, entry: AppEntry) => { store.push(entry); return entry; }),
    updateApp: vi.fn((_addr: string, uuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>) => {
      const idx = store.findIndex((a) => a.leaseUuid === uuid);
      if (idx === -1) return null;
      store[idx] = { ...store[idx], ...updates };
      return store[idx];
    }),
  };
}
