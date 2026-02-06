/**
 * MainLayout — two-panel layout: sidebar + chat.
 * Replaces the old tab-based layout.
 */

import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { AppsSidebar } from './AppsSidebar';
import { ChatPanel } from '../ai/ChatPanel';
import { AIErrorBoundary } from '../ai/AIErrorBoundary';

export function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="main-layout">
      {/* Mobile sidebar toggle */}
      <button
        type="button"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="main-layout__mobile-toggle"
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Sidebar */}
      <aside
        className={`main-layout__sidebar ${sidebarOpen ? 'main-layout__sidebar--open' : ''}`}
      >
        <AppsSidebar onClose={() => setSidebarOpen(false)} />
      </aside>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="main-layout__backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Chat area */}
      <main className="main-layout__chat">
        <AIErrorBoundary>
          <ChatPanel />
        </AIErrorBoundary>
      </main>
    </div>
  );
}
