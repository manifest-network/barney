import { Sidebar, type TabId } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  isProvider: boolean;
  isAdmin: boolean;
}

export function Layout({ children, activeTab, onTabChange, isProvider, isAdmin }: LayoutProps) {
  return (
    <div className="layout">
      <Sidebar
        activeTab={activeTab}
        onTabChange={onTabChange}
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
