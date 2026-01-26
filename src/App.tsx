import { useState, useEffect } from 'react';
import { useChain } from '@cosmos-kit/react';
import { Layout, type TabId } from './components/layout/Layout';
import { WalletTab } from './components/tabs/WalletTab';
import { CatalogTab } from './components/tabs/CatalogTab';
import { LeasesTab } from './components/tabs/LeasesTab';
import { ProviderTab } from './components/tabs/ProviderTab';
import { NetworkTab } from './components/tabs/NetworkTab';
import { getProviders } from './api/sku';
import { getBillingParams } from './api/billing';

const CHAIN_NAME = 'manifestlocal';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('wallet');
  const { address, isWalletConnected, openView, disconnect, wallet } = useChain(CHAIN_NAME);
  const [isProvider, setIsProvider] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check if user is a provider or admin
  useEffect(() => {
    const checkRoles = async () => {
      if (!address) {
        setIsProvider(false);
        setIsAdmin(false);
        return;
      }

      try {
        const [providers, billingParams] = await Promise.all([
          getProviders(),
          getBillingParams().catch(() => ({ allowed_list: [] as string[] })),
        ]);

        // Check if connected address is a provider
        const myProvider = providers.find((p) => p.address === address);
        setIsProvider(!!myProvider);

        // Check if connected address is in billing allowed list
        setIsAdmin(billingParams.allowed_list?.includes(address) ?? false);
      } catch {
        setIsProvider(false);
        setIsAdmin(false);
      }
    };

    checkRoles();
  }, [address]);

  const truncateAddress = (addr: string) => {
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  };

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      address={address}
      isProvider={isProvider}
      isAdmin={isAdmin}
    >
      {/* Header with wallet controls */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-semibold gradient-text">
            {activeTab === 'wallet' && 'Wallet & Credit'}
            {activeTab === 'catalog' && 'Catalog'}
            {activeTab === 'leases' && 'My Leases'}
            {activeTab === 'provider' && 'Provider Dashboard'}
            {activeTab === 'network' && 'Network Overview'}
          </h1>
          <p className="text-sm text-muted mt-1">
            {activeTab === 'wallet' && 'Manage your balances and credit account'}
            {activeTab === 'catalog' && 'Browse providers and SKUs'}
            {activeTab === 'leases' && 'View and manage your active leases'}
            {activeTab === 'provider' && 'Manage your provider operations'}
            {activeTab === 'network' && 'Network-wide billing statistics'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {isWalletConnected && address ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-800/50 border border-surface-700/50">
                {wallet?.logo && (
                  <img
                    src={typeof wallet.logo === 'string' ? wallet.logo : wallet.logo.major}
                    alt={wallet.prettyName}
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
                onClick={() => disconnect()}
                className="btn btn-ghost btn-sm"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
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
          <WalletTab
            isConnected={isWalletConnected}
            address={address}
            onConnect={() => openView()}
          />
        )}
        {activeTab === 'catalog' && (
          <CatalogTab
            isConnected={isWalletConnected}
            address={address}
            onConnect={() => openView()}
          />
        )}
        {activeTab === 'leases' && <LeasesTab />}
        {activeTab === 'provider' && <ProviderTab />}
        {activeTab === 'network' && (
          <NetworkTab
            isConnected={isWalletConnected}
            address={address}
            onConnect={() => openView()}
          />
        )}
      </div>
    </Layout>
  );
}

export default App;
