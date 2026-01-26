import { useEffect } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { useAI } from '../../contexts/AIContext';
import { ChatPanel } from './ChatPanel';

export function ChatBubble() {
  const { isOpen, setIsOpen, isConnected, messages, isStreaming } = useAI();

  // Keyboard shortcut: Ctrl+/ or Cmd+/
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setIsOpen(!isOpen);
      }
      // Also close on Escape when open
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setIsOpen]);

  // Count unread messages (new messages while panel is closed)
  const hasUnread = !isOpen && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

  return (
    <>
      {/* Chat Panel */}
      {isOpen && <ChatPanel />}

      {/* Floating Bubble Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="chat-bubble"
        aria-label={isOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
        title={`AI Assistant (${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+/)`}
      >
        {isOpen ? (
          <X className="w-6 h-6" />
        ) : (
          <>
            <MessageCircle className="w-6 h-6" />
            {/* Connection indicator */}
            <span
              className={`chat-bubble-status ${isConnected ? 'connected' : 'disconnected'}`}
              title={isConnected ? 'Connected to Ollama' : 'Disconnected from Ollama'}
            />
            {/* Unread indicator */}
            {hasUnread && !isStreaming && <span className="chat-bubble-badge" />}
          </>
        )}
      </button>
    </>
  );
}
