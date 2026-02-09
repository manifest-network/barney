/**
 * MainLayout — two-panel layout: sidebar + chat.
 * Replaces the old tab-based layout.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Menu, X } from 'lucide-react';
import { AppsSidebar } from './AppsSidebar';
import { ChatPanel } from '../ai/ChatPanel';
import { AIErrorBoundary } from '../ai/AIErrorBoundary';

const SWIPE_THRESHOLD = 80;

export function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const lastDelta = useRef(0);
  const isSwiping = useRef(false);

  // Close sidebar on Escape
  useEffect(() => {
    if (!sidebarOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen]);

  // Swipe-to-dismiss: track finger, move sidebar in real-time
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    lastDelta.current = 0;
    isSwiping.current = true;
    if (sidebarRef.current) {
      sidebarRef.current.style.transition = 'none';
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isSwiping.current) return;
    const delta = e.touches[0].clientX - touchStartX.current;
    lastDelta.current = delta;
    // Only allow leftward swipe to close
    if (delta < 0) {
      if (sidebarRef.current) {
        sidebarRef.current.style.transform = `translateX(${delta}px)`;
      }
      // Fade backdrop proportionally
      if (backdropRef.current) {
        const progress = Math.min(1, Math.abs(delta) / 280);
        backdropRef.current.style.opacity = String(1 - progress);
      }
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!isSwiping.current) return;
    isSwiping.current = false;
    // Re-enable CSS transitions, clear inline overrides
    if (sidebarRef.current) {
      sidebarRef.current.style.transition = '';
      sidebarRef.current.style.transform = '';
    }
    if (backdropRef.current) {
      backdropRef.current.style.opacity = '';
    }
    // Close if swiped past threshold
    if (lastDelta.current < -SWIPE_THRESHOLD) {
      setSidebarOpen(false);
    }
  }, []);

  return (
    <div className="main-layout">
      <a href="#main-content" className="skip-nav">
        Skip to content
      </a>

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
        ref={sidebarRef}
        className={`main-layout__sidebar ${sidebarOpen ? 'main-layout__sidebar--open' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <AppsSidebar onClose={() => setSidebarOpen(false)} />
      </aside>

      {/* Mobile backdrop (always rendered for animated transitions) */}
      <div
        ref={backdropRef}
        className={`main-layout__backdrop ${sidebarOpen ? 'main-layout__backdrop--visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      {/* Chat area */}
      <main id="main-content" className="main-layout__chat">
        <AIErrorBoundary>
          <ChatPanel />
        </AIErrorBoundary>
      </main>
    </div>
  );
}
