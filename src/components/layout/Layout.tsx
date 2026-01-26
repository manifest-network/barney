import { Sidebar, type TabId } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  address?: string;
  isProvider: boolean;
  isAdmin: boolean;
}

export function Layout({ children, activeTab, onTabChange, address, isProvider, isAdmin }: LayoutProps) {
  return (
    <div className="layout">
      <Sidebar
        activeTab={activeTab}
        onTabChange={onTabChange}
        address={address}
        isProvider={isProvider}
        isAdmin={isAdmin}
      />
      <main className="layout-main">
        {children}
      </main>
    </div>
  );
}

export type { TabId };
