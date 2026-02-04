import { useState, useRef, useEffect, type FormEvent } from 'react';
import { Send, Settings, X, Sparkles, Loader, WifiOff, Maximize2, Minimize2, Paperclip } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { ConfirmationCard } from './ConfirmationCard';
import { AISettings } from './AISettings';
import { MAX_INPUT_LENGTH } from '../../ai/validation';
import { ALLOWED_FILE_EXTENSIONS } from '../../utils/fileValidation';
import { formatFileSize } from '../../utils/format';
import { cn } from '../../utils/cn';

const SUGGESTIONS = ["What's my balance?", "Show my active leases", "List available providers"];

export function ChatPanel() {
  const {
    messages,
    isStreaming,
    isConnected,
    pendingConfirmation,
    pendingPayload,
    sendMessage,
    setIsOpen,
    confirmAction,
    cancelAction,
    attachPayload,
    clearPayload,
  } = useAI();

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { containerRef: messagesContainerRef, endRef: messagesEndRef, handleScroll } = useAutoScroll(messages.length);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachError(null);

    const result = await attachPayload(file);
    if (result.error) {
      setAttachError(result.error);
    }

    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  // Show character count when approaching limit
  const showCharCount = input.length > MAX_INPUT_LENGTH * 0.8;
  const isNearLimit = input.length > MAX_INPUT_LENGTH * 0.95;

  return (
    <div
      className={cn('chat-panel', isExpanded && 'chat-panel-expanded')}
      role="dialog"
      aria-label="AI Assistant chat panel"
      aria-modal="false"
    >
      {/* Header */}
      <div className="chat-panel-header">
        <div className="chat-panel-title">
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          <span id="chat-panel-title">AI Assistant</span>
          {!isConnected && (
            <span
              className="chat-panel-offline"
              title="Disconnected from Ollama"
              role="status"
              aria-label="Disconnected from Ollama"
            >
              <WifiOff className="w-3 h-3" aria-hidden="true" />
            </span>
          )}
        </div>
        <div className="chat-panel-actions">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="chat-panel-btn"
            aria-label={isExpanded ? "Collapse chat panel" : "Expand chat panel"}
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <Minimize2 className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="chat-panel-btn"
            aria-label="Open settings"
            aria-expanded={showSettings}
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="chat-panel-btn"
            aria-label="Close chat panel"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && <AISettings onClose={() => setShowSettings(false)} />}

      {/* Messages Area */}
      <div
        className="chat-messages"
        ref={messagesContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Sparkles className="w-8 h-8 text-primary-400 mb-2" aria-hidden="true" />
            <p className="chat-empty-title">How can I help you today?</p>
            <p className="chat-empty-hint">
              Ask me about your balances, leases, or available providers.
            </p>
            <div className="chat-suggestions" role="group" aria-label="Suggested questions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => sendMessage(text)}
                  className="chat-suggestion"
                  disabled={!isConnected || isStreaming}
                >
                  {text}
                </button>
              ))}
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
      <form onSubmit={handleSubmit} className="chat-input-form" aria-label="Chat input">
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_FILE_EXTENSIONS.join(',')}
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="chat-input-wrapper">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || isStreaming}
            className="chat-attach-btn"
            aria-label="Attach payload file"
            title="Attach deployment payload"
          >
            <Paperclip className="w-4 h-4" aria-hidden="true" />
          </button>
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
            aria-label="Message input"
            aria-describedby="chat-input-hint"
          />
          <button
            type="submit"
            disabled={!input.trim() || !isConnected || isStreaming}
            className="chat-send-btn"
            aria-label={isStreaming ? "Sending message..." : "Send message"}
          >
            {isStreaming ? (
              <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
        {pendingPayload && (
          <div className="chat-attachment-chip" role="status">
            <Paperclip className="w-3 h-3" aria-hidden="true" />
            <span className="chat-attachment-name">
              {pendingPayload.filename || 'payload'} ({formatFileSize(pendingPayload.size)})
            </span>
            <button
              type="button"
              onClick={clearPayload}
              className="chat-attachment-remove"
              aria-label="Remove attachment"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        )}
        {attachError && (
          <p className="chat-input-hint text-error" role="alert">{attachError}</p>
        )}
        <p id="chat-input-hint" className="chat-input-hint">
          {showCharCount ? (
            <span className={isNearLimit ? 'text-warning' : ''} role="status">
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
