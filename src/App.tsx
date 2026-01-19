import { useState } from 'react';
import { WalletTab } from './components/tabs/WalletTab';
import { CatalogTab } from './components/tabs/CatalogTab';
import { LeasesTab } from './components/tabs/LeasesTab';
import { ProviderTab } from './components/tabs/ProviderTab';

type TabId = 'wallet' | 'catalog' | 'leases' | 'provider';

const tabs: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet & Credit' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'leases', label: 'Leases' },
  { id: 'provider', label: 'Provider Dashboard' },
];

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('wallet');
  const [isConnected, setIsConnected] = useState(false);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-700 bg-gray-800 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <h1 className="text-xl font-bold text-white">Billing Module Tester</h1>
          <div className="flex items-center gap-4">
            {isConnected ? (
              <>
                <span className="font-mono text-sm text-gray-400">
                  manifest1tenant...dress
                </span>
                <span className="rounded bg-green-900 px-2 py-1 text-xs text-green-300">
                  Connected
                </span>
              </>
            ) : (
              <button
                onClick={() => setIsConnected(true)}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-gray-700 bg-gray-800">
        <div className="mx-auto max-w-7xl">
          <nav className="flex gap-1 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-blue-500 text-blue-400'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <main className="mx-auto max-w-7xl p-6">
        {activeTab === 'wallet' && <WalletTab isConnected={isConnected} onConnect={() => setIsConnected(true)} />}
        {activeTab === 'catalog' && <CatalogTab />}
        {activeTab === 'leases' && <LeasesTab />}
        {activeTab === 'provider' && <ProviderTab />}
      </main>
    </div>
  );
}

export default App;
