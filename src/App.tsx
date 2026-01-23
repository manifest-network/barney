import { useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import { WalletTab } from './components/tabs/WalletTab';
import { CatalogTab } from './components/tabs/CatalogTab';
import { LeasesTab } from './components/tabs/LeasesTab';
import { ProviderTab } from './components/tabs/ProviderTab';
import { NetworkTab } from './components/tabs/NetworkTab';

type TabId = 'wallet' | 'catalog' | 'leases' | 'provider' | 'network';

const tabs: { id: TabId; label: string; icon: string }[] = [
  { id: 'wallet', label: 'Wallet & Credit', icon: '💳' },
  { id: 'catalog', label: 'Catalog', icon: '📦' },
  { id: 'leases', label: 'Leases', icon: '📋' },
  { id: 'provider', label: 'Provider', icon: '🏢' },
  { id: 'network', label: 'Network', icon: '🌐' },
];

const CHAIN_NAME = 'manifestlocal';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('wallet');
  const { address, isWalletConnected, openView, disconnect, wallet } = useChain(CHAIN_NAME);

  const truncateAddress = (addr: string) => {
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="card-static border-0 border-b rounded-none px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-secondary-500 flex items-center justify-center">
              <span className="text-white text-lg font-bold">M</span>
            </div>
            <h1 className="text-xl font-heading font-semibold gradient-text">
              Billing Module Tester
            </h1>
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
        </div>
      </header>

      {/* Tabs */}
      <div className="card-static border-0 border-b rounded-none">
        <div className="mx-auto max-w-7xl">
          <nav className="nav-tabs px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <main className="flex-1 mx-auto max-w-7xl w-full p-6">
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
      </main>

      {/* Footer */}
      <footer className="card-static border-0 border-t rounded-none px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center justify-between text-sm text-muted">
          <span>Manifest Network Billing Module</span>
          <span className="font-mono text-dim">v0.1.0</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
