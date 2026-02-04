import { useState, useEffect, useCallback } from 'react';
import {
  getProviders,
  getSKUs,
  getSKUsByProvider,
  getSKUParams,
} from '../api';
import type { Provider, SKU, SKUParams } from '../api/sku';
import { getProviderHealth } from '../api/provider-api';
import { getLeasesBySKU, LeaseState } from '../api/billing';
import { useAutoRefreshTab } from './useAutoRefreshTab';
import { HEALTH_CHECK_TIMEOUT_MS } from '../config/constants';
import type { HealthStatus } from '../components/tabs/catalog/types';

interface UseCatalogDataOptions {
  showInactive: boolean;
  selectedProvider: string | null;
}

interface UseCatalogDataReturn {
  providers: Provider[];
  skus: SKU[];
  skuParams: SKUParams | null;
  loading: boolean;
  error: string | null;
  providerHealth: Record<string, HealthStatus>;
  skuUsage: Record<string, { active: number; total: number }>;
  skuUsageLoading: boolean;
  fetchData: () => Promise<void>;
}

export function useCatalogData({ showInactive, selectedProvider }: UseCatalogDataOptions): UseCatalogDataReturn {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [skuParams, setSkuParams] = useState<SKUParams | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<Record<string, HealthStatus>>({});
  const [skuUsage, setSkuUsage] = useState<Record<string, { active: number; total: number }>>({});
  const [skuUsageLoading, setSkuUsageLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);

      const [fetchedProviders, fetchedSkus, fetchedParams] = await Promise.all([
        getProviders(!showInactive),
        selectedProvider
          ? getSKUsByProvider(selectedProvider, !showInactive)
          : getSKUs(!showInactive),
        getSKUParams().catch(() => null),
      ]);

      setProviders(fetchedProviders);
      setSkus(fetchedSkus);
      setSkuParams(fetchedParams);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [showInactive, selectedProvider]);

  useAutoRefreshTab(fetchData);

  // Fetch SKU usage stats (non-blocking)
  useEffect(() => {
    if (skus.length === 0) return;

    const abortController = new AbortController();

    const fetchSkuUsage = async () => {
      setSkuUsageLoading(true);
      const usageRecord: Record<string, { active: number; total: number }> = {};

      await Promise.all(
        skus.map(async (sku) => {
          if (abortController.signal.aborted) return;
          try {
            const [activeLeases, allLeases] = await Promise.all([
              getLeasesBySKU(sku.uuid, LeaseState.LEASE_STATE_ACTIVE),
              getLeasesBySKU(sku.uuid),
            ]);
            usageRecord[sku.uuid] = {
              active: activeLeases.length,
              total: allLeases.length,
            };
          } catch {
            // Ignore errors for individual SKU queries
          }
        })
      );

      if (!abortController.signal.aborted) {
        setSkuUsage(usageRecord);
        setSkuUsageLoading(false);
      }
    };

    fetchSkuUsage();

    return () => {
      abortController.abort();
    };
  }, [skus]);

  // Fetch health status for providers with api_url (non-blocking)
  useEffect(() => {
    const abortController = new AbortController();

    const checkHealth = async () => {
      const providersWithApi = providers.filter((p) => p.apiUrl && p.active);
      if (providersWithApi.length === 0) return;

      setProviderHealth((prev) => {
        const next = { ...prev };
        for (const p of providersWithApi) {
          if (!(p.uuid in next)) {
            next[p.uuid] = 'loading';
          }
        }
        return next;
      });

      const results = await Promise.all(
        providersWithApi.map(async (p) => {
          const health = await getProviderHealth(p.apiUrl, HEALTH_CHECK_TIMEOUT_MS, abortController.signal);
          return { uuid: p.uuid, status: health?.status === 'healthy' ? 'healthy' : 'unhealthy' } as const;
        })
      );

      if (!abortController.signal.aborted) {
        setProviderHealth((prev) => {
          const next = { ...prev };
          for (const r of results) {
            next[r.uuid] = r.status;
          }
          return next;
        });
      }
    };

    checkHealth();

    return () => {
      abortController.abort();
    };
  }, [providers]);

  return {
    providers,
    skus,
    skuParams,
    loading,
    error,
    providerHealth,
    skuUsage,
    skuUsageLoading,
    fetchData,
  };
}
