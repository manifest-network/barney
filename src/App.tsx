import { useState, useEffect } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Layout, type TabId } from './components/layout/Layout';
import { WalletTab } from './components/tabs/WalletTab';
import { CatalogTab } from './components/tabs/CatalogTab';
import { LeasesTab } from './components/tabs/LeasesTab';
import { ProviderTab } from './components/tabs/ProviderTab';
import { NetworkTab } from './components/tabs/NetworkTab';
import { TabErrorBoundary } from './components/ui/ErrorBoundary';
import { getProviders } from './api/sku';
import { getBillingParams } from './api/billing';
import { truncateAddress } from './utils/address';
import { getSafeImageUrl } from './utils/url';

const CHAIN_NAME = 'manifestlocal';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('wallet');
  const { address, isWalletConnected, openView, disconnect, wallet } = useChain(CHAIN_NAME);
  const [isProvider, setIsProvider] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check if user is a provider or admin
  useEffect(() => {
    let isMounted = true;

    const checkRoles = async () => {
      if (!address) {
        if (isMounted) {
          setIsProvider(false);
          setIsAdmin(false);
        }
        return;
      }

      try {
        const [providers, billingParams] = await Promise.all([
          getProviders(),
          getBillingParams().catch(() => ({ allowed_list: [] as string[] })),
        ]);

        // Only update state if component is still mounted
        if (!isMounted) return;

        // Check if connected address is a provider
        const myProvider = providers.find((p) => p.address === address);
        setIsProvider(!!myProvider);

        // Check if connected address is in billing allowed list
        setIsAdmin(billingParams.allowed_list?.includes(address) ?? false);
      } catch {
        if (isMounted) {
          setIsProvider(false);
          setIsAdmin(false);
        }
      }
    };

    checkRoles();

    // Cleanup function to prevent state updates after unmount
    return () => {
      isMounted = false;
    };
  }, [address]);

  // Get safe wallet logo URL
  const walletLogoUrl = wallet?.logo
    ? getSafeImageUrl(typeof wallet.logo === 'string' ? wallet.logo : wallet.logo.major)
    : undefined;

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      isProvider={isProvider}
      isAdmin={isAdmin}
    >
      {/* Header with wallet controls */}
      <header className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-heading font-semibold gradient-text">
          {activeTab === 'wallet' && 'Wallet & Credit'}
          {activeTab === 'catalog' && 'Catalog'}
          {activeTab === 'leases' && 'My Leases'}
          {activeTab === 'provider' && 'Provider Dashboard'}
          {activeTab === 'network' && 'Network Overview'}
        </h1>
        <div className="flex items-center gap-3">
          {isWalletConnected && address ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-800/50 border border-surface-700/50">
                {walletLogoUrl && (
                  <img
                    src={walletLogoUrl}
                    alt={wallet?.prettyName || 'Wallet'}
                    className="h-5 w-5 rounded-full"
                  />
                )}
                <span className="font-mono text-sm text-secondary">
                  {truncateAddress(address)}
                </span>
              </div>
              <span className="badge badge-success">
                Connected
              </span>
              <button
                type="button"
                onClick={() => disconnect()}
                className="btn btn-ghost btn-sm"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => openView()}
              className="btn btn-primary btn-pill"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* Tab Content */}
      <div className="animate-fadeIn">
        {activeTab === 'wallet' && (
          <TabErrorBoundary tabName="Wallet">
            <WalletTab
              isConnected={isWalletConnected}
              address={address}
              onConnect={() => openView()}
            />
          </TabErrorBoundary>
        )}
        {activeTab === 'catalog' && (
          <TabErrorBoundary tabName="Catalog">
            <CatalogTab
              isConnected={isWalletConnected}
              address={address}
              onConnect={() => openView()}
            />
          </TabErrorBoundary>
        )}
        {activeTab === 'leases' && (
          <TabErrorBoundary tabName="Leases">
            <LeasesTab />
          </TabErrorBoundary>
        )}
        {activeTab === 'provider' && (
          <TabErrorBoundary tabName="Provider">
            <ProviderTab />
          </TabErrorBoundary>
        )}
        {activeTab === 'network' && (
          <TabErrorBoundary tabName="Network">
            <NetworkTab
              isConnected={isWalletConnected}
              address={address}
              onConnect={() => openView()}
            />
          </TabErrorBoundary>
        )}
      </div>
    </Layout>
  );
}

export default App;
