import { Wallet, Package, FileText, Building2, Globe } from 'lucide-react';
import { SidebarItem } from './SidebarItem';
import { SidebarSection } from './SidebarSection';

export type TabId = 'wallet' | 'catalog' | 'leases' | 'provider' | 'network';

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  address?: string;
  isProvider: boolean;
  isAdmin: boolean;
}

export function Sidebar({ activeTab, onTabChange, address, isProvider, isAdmin }: SidebarProps) {
  const truncateAddress = (addr: string) => {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <span>M</span>
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-title">Barney</span>
            <span className="sidebar-subtitle">Billing Dashboard</span>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <SidebarSection title="Billing">
          <SidebarItem
            icon={Wallet}
            label="Wallet & Credit"
            isActive={activeTab === 'wallet'}
            onClick={() => onTabChange('wallet')}
          />
          <SidebarItem
            icon={FileText}
            label="My Leases"
            isActive={activeTab === 'leases'}
            onClick={() => onTabChange('leases')}
          />
        </SidebarSection>

        <SidebarSection title="Marketplace">
          <SidebarItem
            icon={Package}
            label="Catalog"
            isActive={activeTab === 'catalog'}
            onClick={() => onTabChange('catalog')}
          />
        </SidebarSection>

        {isProvider && (
          <SidebarSection title="Provider">
            <SidebarItem
              icon={Building2}
              label="Provider Dashboard"
              isActive={activeTab === 'provider'}
              onClick={() => onTabChange('provider')}
            />
          </SidebarSection>
        )}

        {isAdmin && (
          <SidebarSection title="Admin">
            <SidebarItem
              icon={Globe}
              label="Network"
              isActive={activeTab === 'network'}
              onClick={() => onTabChange('network')}
            />
          </SidebarSection>
        )}
      </nav>

      <div className="sidebar-footer">
        {address && (
          <div className="sidebar-address">
            <span className="sidebar-address-label">Connected</span>
            <span className="sidebar-address-value">{truncateAddress(address)}</span>
          </div>
        )}
        <div className="sidebar-version">v0.1.0</div>
      </div>
    </aside>
  );
}
