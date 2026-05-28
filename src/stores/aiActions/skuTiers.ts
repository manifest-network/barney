/**
 * loadSkuTiers / retrySkuTiers — fetch + normalize SKU tiers once at boot.
 * Session-lifetime cache: no periodic refresh, no invalidation.
 *
 * Concurrent calls while a fetch is in-flight return the same in-flight promise
 * so React StrictMode double-invokes don't issue duplicate chain queries.
 */

import { runtimeConfig } from '../../config/runtimeConfig';
import { parseSkuSpecs } from '../../config/skuSpecs';
import { resolveSkuTiers } from '../../api/skuTiers';
import { logError } from '../../utils/errors';
import type { AIStore } from '../aiStore';
import type { ResolvedSkuTier } from '../../api/skuTiers';

type Get = () => AIStore;
type Set = (partial: Partial<AIStore> | ((s: AIStore) => Partial<AIStore>)) => void;

export type SkuTiersPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface SkuTiersState {
  phase: SkuTiersPhase;
  tiers: ResolvedSkuTier[];
  /** First denom symbol from resolved tiers (e.g., 'PWR'). */
  denomSymbol: string;
  /** Set when phase === 'error'. */
  error: string | null;
}

export const initialSkuTiersState: SkuTiersState = {
  phase: 'idle',
  tiers: [],
  denomSymbol: '',
  error: null,
};

export function loadSkuTiersFn(get: Get, set: Set): Promise<void> {
  // The in-flight promise lives on the store as `_skuTiersInFlight` (an
  // internal field; see aiStore.ts). Zustand re-creates the state object on
  // every `set()`, so a module-level Map keyed by state ref would lose track.
  // Keying off the store value instead survives state churn.
  const existing = get()._skuTiersInFlight;
  if (existing) return existing;
  if (get().skuTiers.phase === 'ready') return Promise.resolve();

  set({ skuTiers: { ...get().skuTiers, phase: 'loading', error: null } });

  const specs = parseSkuSpecs(runtimeConfig.PUBLIC_SKU_SPECS);

  const promise = (async () => {
    try {
      const { tiers, denomSymbol } = await resolveSkuTiers(specs);
      if (tiers.length === 0) {
        set({
          skuTiers: {
            phase: 'error',
            tiers: [],
            denomSymbol: '',
            error: 'No tiers available — check PUBLIC_SKU_SPECS and chain SKU catalog.',
          },
        });
        return;
      }
      set({ skuTiers: { phase: 'ready', tiers, denomSymbol, error: null } });
    } catch (err) {
      logError('aiActions.loadSkuTiers', err);
      const msg = err instanceof Error ? err.message : String(err);
      set({
        skuTiers: {
          phase: 'error',
          tiers: [],
          denomSymbol: '',
          error: msg,
        },
      });
    } finally {
      set({ _skuTiersInFlight: null });
    }
  })();

  set({ _skuTiersInFlight: promise });
  return promise;
}

export function retrySkuTiersFn(get: Get, set: Set): Promise<void> {
  const current = get().skuTiers;
  // Retry from ready is a no-op — loadSkuTiersFn short-circuits on ready
  // anyway, and we must not transition ready → idle/loading because
  // consumers (compositeTransactions.ts, sendMessage / confirmAction /
  // toolExecution / batchDeploy action modules) read skuTiers.tiers
  // directly without phase guards. A transient ready → idle window would
  // orphan the resolved tiers from any in-flight tool execution.
  // If we ever need stale-while-revalidate refresh from ready, that should
  // be a separate action (e.g. revalidateSkuTiersFn) with its own
  // isRevalidating flag so consumers can opt in to the new phase shape.
  if (current.phase === 'ready') return Promise.resolve();
  set({ skuTiers: { ...current, phase: 'idle', error: null } });
  return loadSkuTiersFn(get, set);
}
