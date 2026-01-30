import { useState, useEffect, useCallback, useMemo } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Link, Package, Shield, Loader2, Plus, Copy, Check, Search, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { HEALTH_CHECK_TIMEOUT_MS, POST_TX_REFETCH_DELAY_MS } from '../../config/constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { truncateAddress } from '../../utils/address';
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
  Unit,
  DENOMS,
  formatPrice,
} from '../../api';
import type { Provider, SKU, SKUParams } from '../../api/sku';
import { getProviderHealth } from '../../api/provider-api';
import { getLeasesBySKU, LeaseState } from '../../api/billing';
import { useToast } from '../../hooks/useToast';
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { EmptyState } from '../ui/EmptyState';
import { Modal } from '../ui/Modal';
import { ErrorBanner } from '../ui/ErrorBanner';

type HealthStatus = 'healthy' | 'unhealthy' | 'loading' | 'unknown';

const CHAIN_NAME = 'manifestlocal';
const ITEMS_PER_PAGE = 10;

interface CatalogTabProps {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
}

export function CatalogTab({ isConnected, address, onConnect }: CatalogTabProps) {
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

/* ============================================
   SEARCH INPUT
   ============================================ */
function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="catalog-search">
      <Search size={14} className="catalog-search-icon" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="catalog-search-input"
      />
      {value && (
        <button onClick={() => onChange('')} className="catalog-search-clear" title="Clear">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/* ============================================
   PAGINATION
   ============================================ */
function Pagination({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalItems);

  return (
    <div className="catalog-pagination">
      <span className="catalog-pagination-info">
        {startItem}–{endItem} of {totalItems}
      </span>
      <div className="catalog-pagination-controls">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="catalog-pagination-btn"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="catalog-pagination-page">{currentPage} / {totalPages}</span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="catalog-pagination-btn"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

/* ============================================
   PROVIDER CARD
   ============================================ */
function ProviderCard({
  provider,
  isSelected,
  onSelect,
  healthStatus,
  onEdit,
  onDeactivate,
}: {
  provider: Provider;
  isSelected: boolean;
  onSelect: () => void;
  healthStatus?: HealthStatus;
  onEdit?: () => void;
  onDeactivate?: () => void;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div
      className={`catalog-provider-card ${isSelected ? 'selected' : ''}`}
      data-status={provider.active ? 'active' : 'inactive'}
    >
      <div className="catalog-provider-row">
        {/* Status indicator */}
        <span className="catalog-provider-status" data-status={provider.active ? 'active' : 'inactive'}>
          {provider.active ? 'Active' : 'Inactive'}
        </span>

        {/* Content */}
        <div className="catalog-provider-content">
          {/* Identity group */}
          <div className="catalog-provider-identifiers">
            <span className="catalog-provider-labeled-field" data-field="address">
              <span className="catalog-provider-label">Address</span>
              <code className="catalog-provider-mono">{provider.address}</code>
              <button onClick={() => copyToClipboard(provider.address)} className="catalog-copy-btn" title="Copy">
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>

            <span className="catalog-provider-labeled-field" data-field="uuid">
              <span className="catalog-provider-label">UUID</span>
              <code className="catalog-provider-mono">{provider.uuid}</code>
              <button onClick={() => copyToClipboard(provider.uuid)} className="catalog-copy-btn" title="Copy">
                <Copy size={10} />
              </button>
            </span>

            <span className="catalog-provider-labeled-field" data-field="api">
              <span className="catalog-provider-label">API</span>
              {provider.api_url ? (
                <>
                  <code className="catalog-provider-mono">{provider.api_url}</code>
                  <button onClick={() => copyToClipboard(provider.api_url)} className="catalog-copy-btn" title="Copy">
                    <Copy size={10} />
                  </button>
                  {healthStatus && (
                    <span className="catalog-provider-health" data-status={healthStatus} title={healthStatus} />
                  )}
                </>
              ) : (
                <span className="catalog-provider-no-api">Not configured</span>
              )}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="catalog-provider-actions">
          <button onClick={onSelect} className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-ghost'}`}>
            {isSelected ? 'Selected' : 'Filter SKUs'}
          </button>
          {onEdit && (
            <button onClick={onEdit} className="btn btn-ghost btn-sm">Edit</button>
          )}
          {onDeactivate && provider.active && (
            <button onClick={onDeactivate} className="btn btn-danger btn-sm">Deactivate</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   SKU CARD
   ============================================ */
function SKUCard({
  sku,
  providerAddress,
  usage,
  usageLoading,
  onEdit,
  onDeactivate,
}: {
  sku: SKU;
  providerAddress: string;
  usage?: { active: number; total: number };
  usageLoading?: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
}) {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="catalog-sku-card" data-status={sku.active ? 'active' : 'inactive'}>
      <div className="catalog-sku-row">
        {/* Status Badge - fixed width */}
        <span className="catalog-sku-status" data-status={sku.active ? 'active' : 'inactive'}>
          {sku.active ? 'Active' : 'Inactive'}
        </span>

        {/* Content wrapper */}
        <div className="catalog-sku-content">
          {/* Identifiers group */}
          <div className="catalog-sku-identifiers">
            <span className="catalog-sku-labeled-field" data-field="name">
              <span className="catalog-sku-label">Name</span>
              <span className="catalog-sku-value">{sku.name}</span>
            </span>

            <span className="catalog-sku-labeled-field" data-field="address">
              <span className="catalog-sku-label">Address</span>
              <code className="catalog-sku-mono">{providerAddress}</code>
              <button onClick={() => copyToClipboard(providerAddress)} className="catalog-copy-btn" title="Copy Address">
                <Copy size={10} />
              </button>
            </span>

            <span className="catalog-sku-labeled-field" data-field="uuid">
              <span className="catalog-sku-label">UUID</span>
              <code className="catalog-sku-mono">{sku.uuid}</code>
              <button onClick={() => copyToClipboard(sku.uuid)} className="catalog-copy-btn" title="Copy UUID">
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
            </span>
          </div>

          {/* Separator */}
          <div className="catalog-sku-separator" />

          {/* Metrics group */}
          <div className="catalog-sku-metrics">
            <span className="catalog-sku-price">
              {formatPrice(sku.base_price.amount, sku.base_price.denom, sku.unit)}
            </span>

            <span className="catalog-sku-usage">
              {usageLoading ? (
                <Loader2 className="animate-spin" size={12} />
              ) : usage ? (
                <>
                  <span className="catalog-sku-usage-active">{usage.active}</span>
                  <span className="catalog-sku-usage-total">/ {usage.total}</span>
                  <span className="catalog-sku-usage-label">leases</span>
                </>
              ) : (
                <span className="catalog-sku-usage-total">-</span>
              )}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="catalog-sku-actions">
          {onEdit && (
            <button onClick={onEdit} className="btn btn-ghost btn-sm">Edit</button>
          )}
          {onDeactivate && sku.active && (
            <button onClick={onDeactivate} className="btn btn-danger btn-sm">Deactivate</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   FORMS
   ============================================ */
function CreateProviderForm({
  defaultAddress,
  onSubmit,
  onClose,
}: {
  defaultAddress?: string;
  onSubmit: (params: { address: string; payoutAddress: string; apiUrl: string }) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(defaultAddress || '');
  const [payoutAddress, setPayoutAddress] = useState(defaultAddress || '');
  const [apiUrl, setApiUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ address, payoutAddress, apiUrl });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input type="text" value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://..." className="input" />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !address || !payoutAddress} className="btn btn-primary">
          {submitting ? 'Creating...' : 'Create Provider'}
        </button>
      </div>
    </form>
  );
}

function CreateSKUForm({
  providers,
  onSubmit,
  onClose,
}: {
  providers: Provider[];
  onSubmit: (params: { providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string }) => void;
  onClose: () => void;
}) {
  const activeProviders = providers.filter((p) => p.active);
  const [providerUuid, setProviderUuid] = useState(activeProviders[0]?.uuid || '');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<number>(Unit.UNIT_PER_HOUR);
  const [priceAmount, setPriceAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ providerUuid, name, unit, priceAmount, priceDenom: DENOMS.PWR });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select value={providerUuid} onChange={(e) => setProviderUuid(e.target.value)} required className="input select">
          {activeProviders.map((p) => (
            <option key={p.uuid} value={p.uuid}>{truncateAddress(p.address)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Small VM" required className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input type="number" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} placeholder="1000000" required min="1" className="input" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">Unit</label>
          <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="input select">
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !providerUuid || !name || !priceAmount} className="btn btn-success">
          {submitting ? 'Creating...' : 'Create SKU'}
        </button>
      </div>
    </form>
  );
}

function EditProviderForm({
  provider,
  onSubmit,
  onClose,
}: {
  provider: Provider;
  onSubmit: (params: { uuid: string; address: string; payoutAddress: string; apiUrl: string; active: boolean }) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(provider.address);
  const [payoutAddress, setPayoutAddress] = useState(provider.payout_address);
  const [apiUrl, setApiUrl] = useState(provider.api_url || '');
  const [active, setActive] = useState(provider.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ uuid: provider.uuid, address, payoutAddress, apiUrl, active });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-surface-800/50 p-3 text-xs text-muted font-mono">{provider.uuid}</div>
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input type="text" value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://..." className="input" />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 rounded border-surface-500 bg-surface-700" />
        Active
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !address || !payoutAddress} className="btn btn-primary">
          {submitting ? 'Updating...' : 'Update Provider'}
        </button>
      </div>
    </form>
  );
}

function EditSKUForm({
  sku,
  providers,
  onSubmit,
  onClose,
}: {
  sku: SKU;
  providers: Provider[];
  onSubmit: (params: { uuid: string; providerUuid: string; name: string; unit: number; priceAmount: string; priceDenom: string; active: boolean }) => void;
  onClose: () => void;
}) {
  const [providerUuid, setProviderUuid] = useState(sku.provider_uuid);
  const [name, setName] = useState(sku.name);
  const [unit, setUnit] = useState<number>(sku.unit);
  const [priceAmount, setPriceAmount] = useState(sku.base_price.amount);
  const [active, setActive] = useState(sku.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ uuid: sku.uuid, providerUuid, name, unit, priceAmount, priceDenom: sku.base_price.denom, active });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-surface-800/50 p-3 text-xs text-muted font-mono">{sku.uuid}</div>
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select value={providerUuid} onChange={(e) => setProviderUuid(e.target.value)} required className="input select">
          {providers.map((p) => (
            <option key={p.uuid} value={p.uuid}>{truncateAddress(p.address)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Small VM" required className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input type="number" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} placeholder="1000000" required min="1" className="input" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">Unit</label>
          <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="input select">
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 rounded border-surface-500 bg-surface-700" />
        Active
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !providerUuid || !name || !priceAmount} className="btn btn-primary">
          {submitting ? 'Updating...' : 'Update SKU'}
        </button>
      </div>
    </form>
  );
}
