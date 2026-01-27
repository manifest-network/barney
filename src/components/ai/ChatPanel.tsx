import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { Send, Settings, X, Sparkles, Loader, WifiOff, Maximize2, Minimize2 } from 'lucide-react';
import { useAI } from '../../contexts/AIContext';
import { MessageBubble } from './MessageBubble';
import { ConfirmationCard } from './ConfirmationCard';
import { AISettings } from './AISettings';
import { MAX_INPUT_LENGTH } from '../../ai/validation';

export function ChatPanel() {
  const {
    messages,
    isStreaming,
    isConnected,
    pendingConfirmation,
    sendMessage,
    setIsOpen,
    confirmAction,
    cancelAction,
  } = useAI();

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevMessageCountRef = useRef(messages.length);
  const userScrolledUpRef = useRef(false);

  // Check if user is near the bottom of the messages container
  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100; // pixels from bottom
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // Handle user scroll - track if they've scrolled up
  const handleScroll = useCallback(() => {
    userScrolledUpRef.current = !isNearBottom();
  }, [isNearBottom]);

  // Auto-scroll to bottom only when appropriate
  useEffect(() => {
    const messageCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    const isNewMessage = messageCount > prevCount;

    // Update previous count
    prevMessageCountRef.current = messageCount;

    // Auto-scroll if:
    // 1. A new message was added (not just content update), OR
    // 2. User hasn't scrolled up (is near bottom)
    if (isNewMessage || !userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      // Reset scroll tracking when we auto-scroll due to new message
      if (isNewMessage) {
        userScrolledUpRef.current = false;
      }
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSubmit = async () => {
    if (!input.trim() || isStreaming) return;

    const message = input.trim();
    setInput('');
    await sendMessage(message);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  // Handle Enter to submit (Shift+Enter for new line)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
  };

  // Auto-resize textarea with length limit
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // Enforce max length
    if (value.length <= MAX_INPUT_LENGTH) {
      setInput(value);
    }
    // Reset height to auto to get the correct scrollHeight
    e.target.style.height = 'auto';
    // Set height to scrollHeight (max 150px)
    e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
  };

  // Show character count when approaching limit
  const showCharCount = input.length > MAX_INPUT_LENGTH * 0.8;
  const isNearLimit = input.length > MAX_INPUT_LENGTH * 0.95;

  return (
    <div className={`chat-panel ${isExpanded ? 'chat-panel-expanded' : ''}`}>
      {/* Header */}
      <div className="chat-panel-header">
        <div className="chat-panel-title">
          <Sparkles className="w-4 h-4" />
          <span>AI Assistant</span>
          {!isConnected && (
            <span className="chat-panel-offline" title="Disconnected from Ollama">
              <WifiOff className="w-3 h-3" />
            </span>
          )}
        </div>
        <div className="chat-panel-actions">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="chat-panel-btn"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="chat-panel-btn"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="chat-panel-btn"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && <AISettings onClose={() => setShowSettings(false)} />}

      {/* Messages Area */}
      <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Sparkles className="w-8 h-8 text-primary-400 mb-2" />
            <p className="chat-empty-title">How can I help you today?</p>
            <p className="chat-empty-hint">
              Ask me about your balances, leases, or available providers.
            </p>
            <div className="chat-suggestions">
              <button
                type="button"
                onClick={() => sendMessage("What's my balance?")}
                className="chat-suggestion"
              >
                What's my balance?
              </button>
              <button
                type="button"
                onClick={() => sendMessage("Show my active leases")}
                className="chat-suggestion"
              >
                Show my active leases
              </button>
              <button
                type="button"
                onClick={() => sendMessage("List available providers")}
                className="chat-suggestion"
              >
                List available providers
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {/* Pending Confirmation */}
            {pendingConfirmation && (
              <ConfirmationCard
                action={pendingConfirmation.action}
                onConfirm={confirmAction}
                onCancel={cancelAction}
                isExecuting={isStreaming}
              />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="chat-input-form">
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? "Ask me anything..." : "Connecting to Ollama..."}
            disabled={!isConnected || isStreaming}
            className="chat-input"
            rows={1}
            maxLength={MAX_INPUT_LENGTH}
          />
          <button
            type="submit"
            disabled={!input.trim() || !isConnected || isStreaming}
            className="chat-send-btn"
            title="Send message"
          >
            {isStreaming ? (
              <Loader className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="chat-input-hint">
          {showCharCount ? (
            <span className={isNearLimit ? 'text-warning' : ''}>
              {input.length.toLocaleString()} / {MAX_INPUT_LENGTH.toLocaleString()} characters
            </span>
          ) : (
            'Press Enter to send, Shift+Enter for new line'
          )}
        </p>
      </form>
    </div>
  );
}
