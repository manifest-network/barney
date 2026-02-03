import { useState, useEffect, useCallback, useMemo } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Package, Shield, Loader2, Plus, X } from 'lucide-react';
import { HEALTH_CHECK_TIMEOUT_MS, POST_TX_REFETCH_DELAY_MS } from '../../../config/constants';
import { truncateAddress } from '../../../utils/address';
import {
  getProviders,
  getSKUs,
  getSKUsByProvider,
  getSKUParams,
  createProvider,
  updateProvider,
  createSKU,
  updateSKU,
  deactivateProvider,
  deactivateSKU,
} from '../../../api';
import type { Provider, SKU, SKUParams } from '../../../api/sku';
import { getProviderHealth } from '../../../api/provider-api';
import { getLeasesBySKU, LeaseState } from '../../../api/billing';
import { useToast } from '../../../hooks/useToast';
import { useAutoRefreshContext } from '../../../contexts/AutoRefreshContext';
import { EmptyState } from '../../ui/EmptyState';
import { Modal } from '../../ui/Modal';
import { ErrorBanner } from '../../ui/ErrorBanner';
import { Pagination } from '../../ui/Pagination';
import { CHAIN_NAME } from '../../../config/chain';
import { SearchInput } from './SearchInput';
import { ProviderCard } from './ProviderCard';
import { SKUCard } from './SKUCard';
import { CreateProviderForm, EditProviderForm } from './ProviderForms';
import { CreateSKUForm, EditSKUForm } from './SKUForms';
import type { HealthStatus } from './types';
import { ITEMS_PER_PAGE } from './types';

export function CatalogTab({ isConnected, address, onConnect }: { isConnected: boolean; address?: string; onConnect: () => void }) {
  const { getOfflineSignerDirect } = useChain(CHAIN_NAME);
  const toast = useToast();

  // Filters and pagination
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState('');
  const [skuSearch, setSkuSearch] = useState('');
  const [providerPage, setProviderPage] = useState(1);
  const [skuPage, setSkuPage] = useState(1);
  const [showInactive, setShowInactive] = useState(false);

  // Modals
  const [showCreateProvider, setShowCreateProvider] = useState(false);
  const [showCreateSKU, setShowCreateSKU] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [editingSKU, setEditingSKU] = useState<SKU | null>(null);

  // Data
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [skuParams, setSkuParams] = useState<SKUParams | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<Record<string, HealthStatus>>({});
  const [skuUsage, setSkuUsage] = useState<Record<string, { active: number; total: number }>>({});
  const [skuUsageLoading, setSkuUsageLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
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

  const { registerFetchFn, unregisterFetchFn } = useAutoRefreshContext();

  useEffect(() => {
    registerFetchFn(fetchData);
    return () => unregisterFetchFn();
  }, [fetchData, registerFetchFn, unregisterFetchFn]);

  // Filter and paginate providers
  const filteredProviders = useMemo(() => {
    if (!providerSearch.trim()) return providers;
    const search = providerSearch.toLowerCase();
    return providers.filter(p =>
      p.address.toLowerCase().includes(search) ||
      p.uuid.toLowerCase().includes(search) ||
      (p.api_url && p.api_url.toLowerCase().includes(search))
    );
  }, [providers, providerSearch]);

  const paginatedProviders = useMemo(() => {
    const start = (providerPage - 1) * ITEMS_PER_PAGE;
    return filteredProviders.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredProviders, providerPage]);

  const providerTotalPages = Math.ceil(filteredProviders.length / ITEMS_PER_PAGE);

  // Filter and paginate SKUs
  const filteredSkus = useMemo(() => {
    if (!skuSearch.trim()) return skus;
    const search = skuSearch.toLowerCase();
    return skus.filter(s =>
      s.name.toLowerCase().includes(search) ||
      s.uuid.toLowerCase().includes(search)
    );
  }, [skus, skuSearch]);

  const paginatedSkus = useMemo(() => {
    const start = (skuPage - 1) * ITEMS_PER_PAGE;
    return filteredSkus.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredSkus, skuPage]);

  const skuTotalPages = Math.ceil(filteredSkus.length / ITEMS_PER_PAGE);

  // Reset pagination when search changes
  useEffect(() => { setProviderPage(1); }, [providerSearch]);
  useEffect(() => { setSkuPage(1); }, [skuSearch, selectedProvider]);

  // Fetch SKU usage stats (non-blocking)
  useEffect(() => {
    const fetchSkuUsage = async () => {
      if (skus.length === 0) return;

      setSkuUsageLoading(true);
      const usageRecord: Record<string, { active: number; total: number }> = {};

      await Promise.all(
        skus.map(async (sku) => {
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

      setSkuUsage(usageRecord);
      setSkuUsageLoading(false);
    };

    fetchSkuUsage();
  }, [skus]);

  // Fetch health status for providers with api_url (non-blocking)
  useEffect(() => {
    const abortController = new AbortController();

    const checkHealth = async () => {
      const providersWithApi = providers.filter((p) => p.api_url && p.active);
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
          const health = await getProviderHealth(p.api_url, HEALTH_CHECK_TIMEOUT_MS, abortController.signal);
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

  const getProviderAddress = (uuid: string) => {
    const provider = providers.find((p) => p.uuid === uuid);
    return provider?.address || 'Unknown';
  };

  const isInSKUAllowedList = address && skuParams?.allowed_list?.includes(address);

  // Handlers
  const handleDeactivateProvider = async (uuid: string) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await deactivateProvider(signer, address, uuid);
    if (result.success) {
      toast.success(`Provider deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to deactivate provider');
    }
  };

  const handleDeactivateSKU = async (uuid: string) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await deactivateSKU(signer, address, uuid);
    if (result.success) {
      toast.success(`SKU deactivated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to deactivate SKU');
    }
  };

  const handleCreateProvider = async (params: { address: string; payoutAddress: string; apiUrl: string }) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await createProvider(signer, address, params);
    if (result.success) {
      toast.success(`Provider created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setShowCreateProvider(false);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to create provider');
    }
  };

  const handleUpdateProvider = async (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await updateProvider(signer, address, params);
    if (result.success) {
      toast.success(`Provider updated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setEditingProvider(null);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to update provider');
    }
  };

  const handleCreateSKU = async (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await createSKU(signer, address, {
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: { denom: params.priceDenom, amount: params.priceAmount },
    });

    if (result.success) {
      toast.success(`SKU created! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setShowCreateSKU(false);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to create SKU');
    }
  };

  const handleUpdateSKU = async (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => {
    if (!address) return;
    const signer = getOfflineSignerDirect();
    if (!signer) { toast.error('Failed to get signer'); return; }

    const result = await updateSKU(signer, address, {
      uuid: params.uuid,
      providerUuid: params.providerUuid,
      name: params.name,
      unit: params.unit,
      basePrice: { denom: params.priceDenom, amount: params.priceAmount },
      active: params.active,
    });

    if (result.success) {
      toast.success(`SKU updated! Tx: ${result.transactionHash?.slice(0, 16)}...`);
      setEditingSKU(null);
      setTimeout(fetchData, POST_TX_REFETCH_DELAY_MS);
    } else {
      toast.error(result.error || 'Failed to update SKU');
    }
  };

  const handleSelectProvider = (uuid: string | null) => {
    setSelectedProvider(uuid);
    setSkuSearch('');
  };

  if (!isConnected) {
    return (
      <EmptyState
        icon={Link}
        title="Connect Your Wallet"
        description="Connect your wallet to manage providers and SKUs"
        action={{ label: 'Connect Wallet', onClick: onConnect }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner error={error} onRetry={fetchData} />}

      {/* Admin Banner */}
      <div className="catalog-admin-banner" data-role={isInSKUAllowedList ? 'admin' : 'viewer'}>
        <div className="catalog-admin-icon">
          {isInSKUAllowedList ? <Shield size={16} /> : <Package size={16} />}
        </div>
        <div className="catalog-admin-info">
          <div className="catalog-admin-title">
            {isInSKUAllowedList ? 'SKU Module Admin' : 'Read-Only Access'}
          </div>
          <div className="catalog-admin-desc">
            {isInSKUAllowedList
              ? 'You can create and manage providers and SKUs'
              : 'You can view providers and SKUs but cannot modify them'}
          </div>
        </div>
      </div>

      {/* Global Controls */}
      <div className="catalog-controls">
        <div className="catalog-controls-left">
          <label className="catalog-checkbox-label">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
        </div>
        {isInSKUAllowedList && (
          <div className="catalog-controls-right">
            <button onClick={() => setShowCreateProvider(true)} className="btn btn-primary btn-sm">
              <Plus size={14} /> Provider
            </button>
            <button
              onClick={() => setShowCreateSKU(true)}
              disabled={providers.filter((p) => p.active).length === 0}
              className="btn btn-success btn-sm"
            >
              <Plus size={14} /> SKU
            </button>
          </div>
        )}
      </div>

      {/* Providers Section */}
      <div className="catalog-section">
        <div className="catalog-section-header">
          <div className="catalog-section-title">
            Providers
            <span className="catalog-section-count">({filteredProviders.length})</span>
          </div>
          <SearchInput
            value={providerSearch}
            onChange={setProviderSearch}
            placeholder="Search providers..."
          />
        </div>

        {loading && providers.length === 0 ? (
          <div className="catalog-loading">
            <Loader2 className="animate-spin" size={16} />
            Loading providers...
          </div>
        ) : filteredProviders.length === 0 ? (
          <div className="catalog-empty">
            <span className="catalog-empty-text">
              {providerSearch ? 'No providers match your search' : 'No providers found'}
            </span>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {paginatedProviders.map((provider) => (
                <ProviderCard
                  key={provider.uuid}
                  provider={provider}
                  isSelected={selectedProvider === provider.uuid}
                  onSelect={() => handleSelectProvider(selectedProvider === provider.uuid ? null : provider.uuid)}
                  healthStatus={providerHealth[provider.uuid]}
                  onEdit={isInSKUAllowedList ? () => setEditingProvider(provider) : undefined}
                  onDeactivate={isInSKUAllowedList ? () => handleDeactivateProvider(provider.uuid) : undefined}
                />
              ))}
            </div>
            {providerTotalPages > 1 && (
              <Pagination
                currentPage={providerPage}
                totalPages={providerTotalPages}
                totalItems={filteredProviders.length}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setProviderPage}
              />
            )}
          </>
        )}
      </div>

      {/* SKUs Section */}
      <div className="catalog-section">
        <div className="catalog-section-header">
          <div className="catalog-section-title">
            SKUs
            {selectedProvider && (
              <button
                onClick={() => handleSelectProvider(null)}
                className="catalog-filter-badge"
                title="Clear filter"
              >
                {truncateAddress(getProviderAddress(selectedProvider))}
                <X size={12} />
              </button>
            )}
            <span className="catalog-section-count">({filteredSkus.length})</span>
          </div>
          <SearchInput
            value={skuSearch}
            onChange={setSkuSearch}
            placeholder="Search SKUs..."
          />
        </div>

        {loading && skus.length === 0 ? (
          <div className="catalog-loading">
            <Loader2 className="animate-spin" size={16} />
            Loading SKUs...
          </div>
        ) : filteredSkus.length === 0 ? (
          <div className="catalog-empty">
            <span className="catalog-empty-text">
              {skuSearch ? 'No SKUs match your search' : 'No SKUs found'}
            </span>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {paginatedSkus.map((sku) => (
                <SKUCard
                  key={sku.uuid}
                  sku={sku}
                  providerAddress={getProviderAddress(sku.provider_uuid)}
                  usage={skuUsage[sku.uuid]}
                  usageLoading={skuUsageLoading && !(sku.uuid in skuUsage)}
                  onEdit={isInSKUAllowedList ? () => setEditingSKU(sku) : undefined}
                  onDeactivate={isInSKUAllowedList ? () => handleDeactivateSKU(sku.uuid) : undefined}
                />
              ))}
            </div>
            {skuTotalPages > 1 && (
              <Pagination
                currentPage={skuPage}
                totalPages={skuTotalPages}
                totalItems={filteredSkus.length}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setSkuPage}
              />
            )}
          </>
        )}
      </div>

      {/* Modals */}
      <Modal isOpen={showCreateProvider} onClose={() => setShowCreateProvider(false)} title="Create Provider">
        <CreateProviderForm defaultAddress={address} onSubmit={handleCreateProvider} onClose={() => setShowCreateProvider(false)} />
      </Modal>

      <Modal isOpen={showCreateSKU} onClose={() => setShowCreateSKU(false)} title="Create SKU">
        <CreateSKUForm providers={providers} onSubmit={handleCreateSKU} onClose={() => setShowCreateSKU(false)} />
      </Modal>

      <Modal isOpen={!!editingProvider} onClose={() => setEditingProvider(null)} title="Edit Provider">
        {editingProvider && (
          <EditProviderForm provider={editingProvider} onSubmit={handleUpdateProvider} onClose={() => setEditingProvider(null)} />
        )}
      </Modal>

      <Modal isOpen={!!editingSKU} onClose={() => setEditingSKU(null)} title="Edit SKU">
        {editingSKU && (
          <EditSKUForm sku={editingSKU} providers={providers} onSubmit={handleUpdateSKU} onClose={() => setEditingSKU(null)} />
        )}
      </Modal>
    </div>
  );
}
