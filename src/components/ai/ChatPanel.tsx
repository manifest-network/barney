import { useState, useRef, useEffect, type FormEvent } from 'react';
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

const GAME_MANIFEST = (game: string) => ({
  image: `docker.io/lifted/demo-games:${game}`,
  ports: { '8080/tcp': {} },
  env: {},
  read_only: true,
  tmpfs: ['/var/cache/nginx', '/var/run'],
});

const EXAMPLE_APPS = [
  { label: 'Tetris', manifest: GAME_MANIFEST('tetris') },
  { label: '2048', manifest: GAME_MANIFEST('2048') },
  { label: 'Pac-Man', manifest: GAME_MANIFEST('pacman') },
  { label: 'Floppy Bird', manifest: GAME_MANIFEST('floppybird') },
  { label: 'Hextris', manifest: GAME_MANIFEST('hextris') },
  { label: 'Clumsy Bird', manifest: GAME_MANIFEST('clumsy-bird') },
  { label: 'Scorch', manifest: GAME_MANIFEST('scorch') },
  { label: 'Secret Agent', manifest: GAME_MANIFEST('secretagent') },
  { label: 'SimCity', manifest: GAME_MANIFEST('simcity') },
  { label: 'SimCity 2000', manifest: GAME_MANIFEST('simcity2000') },
  { label: 'Colossal Cave', manifest: GAME_MANIFEST('colossalcave') },
  { label: 'Civilization', manifest: GAME_MANIFEST('civilization') },
  { label: 'Space Quest 4', manifest: GAME_MANIFEST('spacequest4') },
  { label: "King's Quest 5", manifest: GAME_MANIFEST('kingsquest5') },
  { label: "King's Quest 6", manifest: GAME_MANIFEST('kingsquest6') },
  { label: "King's Quest 7", manifest: GAME_MANIFEST('kingsquest7') },
  { label: 'Monkey Island', manifest: GAME_MANIFEST('monkeyisland') },
  { label: 'Battle Chess', manifest: GAME_MANIFEST('battlechess') },
  { label: 'Oregon Trail', manifest: GAME_MANIFEST('oregontrail') },
];

const SUGGESTIONS = ['Deploy an app', 'Check my credits', "What's running?"];

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
  } = useAI();

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { containerRef: messagesContainerRef, endRef: messagesEndRef, handleScroll } = useAutoScroll(messages.length, isStreaming);

  // Focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSubmit = async () => {
    // Allow submit with just an attachment (no text required)
    if ((!input.trim() && !pendingPayload) || isStreaming) return;

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

  const deployExample = async (app: typeof EXAMPLE_APPS[number]) => {
    const filename = `manifest-${app.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
    const blob = new Blob([JSON.stringify(app.manifest, null, 2)], { type: 'application/json' });
    const file = new File([blob], filename, { type: 'application/json' });
    const result = await attachPayload(file);
    if (result.error) {
      setAttachError(result.error);
      return;
    }
    try {
      await sendMessage(`Deploy ${app.label}`);
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
                <div className="chat-example-apps__buttons" role="group" aria-label="Example apps">
                  {EXAMPLE_APPS.map((app) => (
                    <button
                      key={app.label}
                      type="button"
                      onClick={() => deployExample(app)}
                      className="chat-suggestion"
                      disabled={!isConnected || isStreaming}
                    >
                      {app.label}
                    </button>
                  ))}
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
              <ProgressCard progress={deployProgress} />
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
            'Press Enter to send, Shift+Enter for new line'
          )}
        </p>
      </form>
    </div>
  );
}
