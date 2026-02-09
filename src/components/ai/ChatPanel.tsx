import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { Send, Settings, X, Sparkles, Loader, WifiOff, Paperclip } from 'lucide-react';
import { useAI } from '../../hooks/useAI';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { ConfirmationCard } from './ConfirmationCard';
import { ProgressCard } from './ProgressCard';
import { AISettings } from './AISettings';
import { MAX_INPUT_LENGTH } from '../../ai/validation';
import { ALLOWED_FILE_EXTENSIONS } from '../../utils/fileValidation';
import { formatFileSize } from '../../utils/format';
import { logError } from '../../utils/errors';
import { EXAMPLE_APPS, buildExampleManifest, type ExampleApp } from '../../config/exampleApps';

const EXAMPLE_GAMES = EXAMPLE_APPS.filter((app) => app.group === 'games');
const EXAMPLE_SERVICES = EXAMPLE_APPS.filter((app) => app.group === 'apps');

const SUGGESTIONS = ['Deploy an app', 'Check my credits', "What's running?"];

/**
 * Match user input against an EXAMPLE_APPS label.
 * First tries exact normalized match, then falls back to token-prefix
 * matching so "king quest 5" matches "King's Quest 5" (possessives, etc.).
 */
function matchExampleApp(input: string): ExampleApp | undefined {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Exact normalized match
  const exact = EXAMPLE_APPS.find(
    (app) => app.label.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
  );
  if (exact) return exact;

  // Token-prefix: split into words, each input word must be a prefix of
  // the corresponding label word (or vice versa). Handles possessives
  // ("king" matches "kings" from "King's") and abbreviations.
  const inputWords = input.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
  return EXAMPLE_APPS.find((app) => {
    const labelWords = app.label.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
    if (inputWords.length !== labelWords.length) return false;
    return inputWords.every((iw, i) =>
      labelWords[i].startsWith(iw) || iw.startsWith(labelWords[i])
    );
  });
}

export function ChatPanel() {
  const {
    messages,
    isStreaming,
    isConnected,
    pendingConfirmation,
    pendingPayload,
    deployProgress,
    sendMessage,
    confirmAction,
    cancelAction,
    attachPayload,
    clearPayload,
    requestBatchDeploy,
  } = useAI();

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { containerRef: messagesContainerRef, endRef: messagesEndRef, handleScroll } = useAutoScroll(messages.length, isStreaming);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);

  const updateScrollShadows = useCallback(() => {
    const container = messagesContainerRef.current;
    const wrapper = scrollWrapperRef.current;
    if (!container || !wrapper) return;
    wrapper.dataset.shadowTop = String(container.scrollTop > 0);
    wrapper.dataset.shadowBottom = String(
      container.scrollHeight - container.scrollTop - container.clientHeight > 1
    );
  }, [messagesContainerRef]);

  const onScroll = useCallback(() => {
    handleScroll();
    updateScrollShadows();
  }, [handleScroll, updateScrollShadows]);

  // Update scroll shadows when content changes
  useEffect(() => {
    const raf = requestAnimationFrame(updateScrollShadows);
    return () => cancelAnimationFrame(raf);
  }, [messages.length, isStreaming, updateScrollShadows]);

  // Focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Press "/" anywhere to focus the chat input (unless already typing somewhere)
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current
          && !(document.activeElement instanceof HTMLInputElement)
          && !(document.activeElement instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  const doSubmit = async () => {
    // Allow submit with just an attachment (no text required)
    if ((!input.trim() && !pendingPayload) || isStreaming) return;

    const message = input.trim();
    setInput('');

    // Match "deploy <example> [and <example> ...]" when no file is already attached
    // Batch deploy for known example apps.
    // Currently only matches against EXAMPLE_APPS. To support arbitrary
    // Docker images (e.g. "deploy foo/bar and baz/qux"), this would need:
    //   1. A regex to detect Docker image refs (account/repo:tag patterns)
    //   2. Manifest construction from image names — requires knowing the
    //      exposed port, which example apps hardcode as 8080/tcp. Arbitrary
    //      images would need a default port assumption or an LLM step to ask.
    //   3. Call requestBatchDeploy() with the constructed manifests.
    // The downstream batch machinery (executeBatchDeploy, deploySingleApp,
    // ProgressCard batch rendering) is image-agnostic and needs no changes.
    if (!pendingPayload) {
      const deployMatch = message.match(/^deploy\s+(.+)$/i);
      if (deployMatch) {
        // Split on "and", ",", "&" to support multi-app deploys
        const names = deployMatch[1]
          .split(/\s*(?:,\s*(?:and\s+)?|&|\band\b)\s*/i)
          .map((s) => s.trim())
          .filter(Boolean);

        const matched = names
          .map((name) => matchExampleApp(name))
          .filter((app): app is ExampleApp => app != null);

        if (matched.length > 1) {
          await requestBatchDeploy(matched, message);
          return;
        }
        if (matched.length === 1) {
          await deployExample(matched[0]);
          return;
        }
      }
    }

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

  const deployExample = async (app: ExampleApp) => {
    const manifestJson = buildExampleManifest(app);
    const filename = `manifest-${app.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
    const blob = new Blob([manifestJson], { type: 'application/json' });
    const file = new File([blob], filename, { type: 'application/json' });
    const result = await attachPayload(file);
    if (result.error) {
      setAttachError(result.error);
      return;
    }
    try {
      const sizeHint = app.size ? ` using ${app.size} tier` : '';
      await sendMessage(`Deploy ${app.label}${sizeHint}`);
    } catch (error) {
      logError('ChatPanel.deployExample', error);
    }
  };

  // Show character count when approaching limit
  const showCharCount = input.length > MAX_INPUT_LENGTH * 0.8;
  const isNearLimit = input.length > MAX_INPUT_LENGTH * 0.95;

  // Show example app buttons when:
  // - the user's most recent message mentions deploy/games, OR
  // - the assistant's last response mentions "example apps below"
  const GAME_TRIGGER_USER = /deploy an app|show\b.*\bgames|example apps|browse\b.*\bgames|more games/i;
  const GAME_TRIGGER_AI = /example apps below/i;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const lastMsg = messages[messages.length - 1];
  const userTriggered = lastUserMsg != null
    && GAME_TRIGGER_USER.test(lastUserMsg.content)
    && !lastUserMsg.content.includes('(File attached:');
  const aiTriggered = lastMsg?.role === 'assistant' && GAME_TRIGGER_AI.test(lastMsg.content);
  const showExampleApps = !isStreaming
    && !pendingConfirmation
    && !deployProgress
    && messages.length >= 2
    && (userTriggered || aiTriggered)
    && lastMsg?.role === 'assistant';

  return (
    <div
      className="chat-panel chat-panel--fullscreen"
      role="region"
      aria-label="Chat"
    >
      {/* Header */}
      <div className="chat-panel-header">
        <div className="chat-panel-title">
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          <span id="chat-panel-title">Barney</span>
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
            onClick={() => setShowSettings(!showSettings)}
            className="chat-panel-btn"
            aria-label="Open settings"
            aria-expanded={showSettings}
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && <AISettings onClose={() => setShowSettings(false)} />}

      {/* Messages Area */}
      <div className="chat-messages-scroll-wrapper" ref={scrollWrapperRef}>
      <div
        className="chat-messages"
        ref={messagesContainerRef}
        onScroll={onScroll}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Sparkles className="w-8 h-8 text-primary-400 mb-2" aria-hidden="true" />
            <p className="chat-empty-title">What would you like to deploy?</p>
            <p className="chat-empty-hint">
              Drop a manifest file or ask me anything about your apps and credits.
            </p>
            <div className="chat-suggestions" role="group" aria-label="Suggested actions">
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
            {/* Example app buttons after deploy explanation */}
            {showExampleApps && (
              <div className="chat-example-apps">
                <p className="chat-example-apps__label">Or try an example:</p>
                <div className="chat-example-apps__groups">
                  <div className="chat-example-apps__group">
                    <p className="chat-example-apps__group-label">Games</p>
                    <div className="chat-example-apps__buttons" role="group" aria-label="Example games">
                      {EXAMPLE_GAMES.map((app, i) => (
                        <button
                          key={app.label}
                          type="button"
                          onClick={() => deployExample(app)}
                          className="chat-suggestion chat-example-apps__stagger"
                          style={{ '--stagger': i } as React.CSSProperties}
                          disabled={!isConnected || isStreaming}
                        >
                          {app.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="chat-example-apps__group">
                    <p className="chat-example-apps__group-label">Apps</p>
                    <div className="chat-example-apps__buttons" role="group" aria-label="Example apps">
                      {EXAMPLE_SERVICES.map((app, i) => (
                        <button
                          key={app.label}
                          type="button"
                          onClick={() => deployExample(app)}
                          className="chat-suggestion chat-suggestion--app chat-example-apps__stagger"
                          style={{ '--stagger': i } as React.CSSProperties}
                          disabled={!isConnected || isStreaming}
                        >
                          {app.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* Pending Confirmation */}
            {pendingConfirmation && (
              <ConfirmationCard
                action={pendingConfirmation.action}
                onConfirm={confirmAction}
                onCancel={cancelAction}
                isExecuting={isStreaming}
              />
            )}
            {/* Deploy Progress */}
            {deployProgress && !pendingConfirmation && (
              <ProgressCard
                progress={deployProgress}
                onRetry={deployProgress.phase === 'failed' ? () => {
                  const lastDeploy = [...messages].reverse().find(
                    (m) => m.role === 'user' && /deploy\b/i.test(m.content)
                  );
                  if (lastDeploy) sendMessage(lastDeploy.content);
                } : undefined}
              />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>
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
            disabled={(!input.trim() && !pendingPayload) || !isConnected || isStreaming}
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
            'Enter to send \u00b7 Shift+Enter for new line \u00b7 / to focus'
          )}
        </p>
      </form>
    </div>
  );
}
