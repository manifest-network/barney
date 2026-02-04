import { Wallet, Package, FileText, Building2, Globe, RefreshCw } from 'lucide-react';
import { SidebarItem } from './SidebarItem';
import { SidebarSection } from './SidebarSection';
import { useAutoRefreshContext } from '../../contexts/AutoRefreshContext';
import { AUTO_REFRESH_INTERVAL_SECONDS } from '../../config/constants';
import { cn } from '../../utils/cn';

export type TabId = 'wallet' | 'catalog' | 'leases' | 'provider' | 'network';

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  isProvider: boolean;
  isAdmin: boolean;
}

export function Sidebar({ activeTab, onTabChange, isProvider, isAdmin }: SidebarProps) {
  const { isEnabled, toggle, isRefreshing, lastRefresh, refresh } = useAutoRefreshContext();

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
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
        {/* Auto-refresh controls */}
        <div className="sidebar-refresh">
          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="sidebar-refresh-btn"
            title="Refresh now"
          >
            <RefreshCw size={14} className={cn(isRefreshing && 'animate-spin')} />
          </button>
          <div className="sidebar-refresh-info">
            <button
              onClick={toggle}
              className={cn('sidebar-refresh-toggle', isEnabled && 'active')}
              title={isEnabled ? 'Disable auto-refresh' : 'Enable auto-refresh'}
            >
              <span className="sidebar-refresh-toggle-knob" />
            </button>
            <span className="sidebar-refresh-label">
              {isEnabled ? `${AUTO_REFRESH_INTERVAL_SECONDS}s` : 'Off'}
            </span>
          </div>
          {lastRefresh && (
            <span className="sidebar-refresh-time" title={`Last: ${formatTime(lastRefresh)}`}>
              {formatTime(lastRefresh)}
            </span>
          )}
        </div>
        <div className="sidebar-version">v0.1.0</div>
      </div>
    </aside>
  );
}
