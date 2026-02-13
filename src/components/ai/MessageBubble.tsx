import { useState, memo, useMemo } from 'react';
import { User, Bot, Wrench, AlertCircle, Brain, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { ChatMessage } from '../../contexts/aiTypes';
import { StreamingText } from './StreamingText';
import { LogCard } from './LogCard';
import { HelpCard } from './HelpCard';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAI } from '../../hooks/useAI';

interface ErrorSuggestion {
  label: string;
  message: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; suggestions: ErrorSuggestion[] }> = [
  {
    pattern: /wallet not connected|not connected/i,
    suggestions: [{ label: 'Connect wallet', message: 'How do I connect my wallet?' }],
  },
  {
    pattern: /insufficient|not enough|credit|balance/i,
    suggestions: [{ label: 'Check credits', message: 'Check my credits' }],
  },
  {
    pattern: /no app found|not found.*app/i,
    suggestions: [
      { label: 'List apps', message: "What's running?" },
    ],
  },
  {
    pattern: /manifest|payload|invalid.*json|hash.*mismatch/i,
    suggestions: [{ label: 'Deploy an app', message: 'Deploy an app' }],
  },
  {
    pattern: /timeout|timed out|polling/i,
    suggestions: [{ label: 'Check status', message: "What's running?" }],
  },
  {
    pattern: /sign|signature|rejected/i,
    suggestions: [{ label: 'Try again', message: 'Deploy an app' }],
  },
];

function getErrorSuggestions(error: string): ErrorSuggestion[] {
  for (const { pattern, suggestions } of ERROR_PATTERNS) {
    if (pattern.test(error)) return suggestions;
  }
  return [];
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, thinking, isStreaming, error, toolName, toolDescription } = message;
  const timeLabel = useMemo(() => formatTimestamp(message.timestamp), [message.timestamp]);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [isToolExpanded, setIsToolExpanded] = useState(false);
  const { copied, copyToClipboard } = useCopyToClipboard();
  const { sendMessage } = useAI();
  const suggestions = error ? getErrorSuggestions(error) : [];

  const isUser = role === 'user';
  const isTool = role === 'tool';
  const isAssistant = role === 'assistant';
  const hasThinking = isAssistant && thinking && thinking.length > 0;
  const hasHelpCard = isAssistant && message.card?.type === 'help';

  // Skip empty assistant messages (tool call with no text)
  if (isAssistant && !content && !hasThinking && !error && !isStreaming && !hasHelpCard) {
    return null;
  }

  // Format content for display
  const formatContent = (text: string, streaming?: boolean) => {
    // Try to detect and format JSON
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        return (
          <pre className="message-json" tabIndex={0} aria-label="JSON data">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        );
      } catch {
        // Not valid JSON, display as text
      }
    }
    return <StreamingText text={text} isStreaming={streaming} />;
  };

  const roleLabel = isUser ? 'You' : isTool ? `Tool: ${toolName || 'result'}` : 'AI Assistant';

  return (
    <div
      className={`message ${isUser ? 'message-user' : isTool ? 'message-tool' : 'message-assistant'}`}
      role="article"
      aria-label={`Message from ${roleLabel}`}
    >
      <div className="message-avatar" aria-hidden="true">
        {isUser ? (
          <User className="w-4 h-4" />
        ) : isTool ? (
          <Wrench className="w-4 h-4" />
        ) : (
          <Bot className="w-4 h-4" />
        )}
      </div>
      <div className="message-content">
        {/* Tool results: LogCard for logs, collapsible block for others */}
        {isTool && message.card?.type === 'logs' && (
          <LogCard
            appName={(message.card.data as { app_name: string }).app_name}
            logs={(message.card.data as { logs: Record<string, string> }).logs}
            truncated={(message.card.data as { truncated: boolean }).truncated}
          />
        )}
        {isTool && !message.card && (
          <div className="message-tool-block">
            <button
              type="button"
              onClick={() => setIsToolExpanded(!isToolExpanded)}
              className="message-tool-toggle"
              aria-expanded={isToolExpanded}
              aria-label={`${isToolExpanded ? 'Collapse' : 'Expand'} tool result for ${toolName || 'tool'}`}
            >
              {isToolExpanded ? (
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-3 h-3" aria-hidden="true" />
              )}
              <Wrench className="w-3 h-3" aria-hidden="true" />
              <span>{toolDescription || toolName || 'Tool result'}</span>
            </button>
            {isToolExpanded && content && (
              <div className="message-tool-content">
                {formatContent(content, false)}
              </div>
            )}
          </div>
        )}
        {/* Thinking block (collapsible) */}
        {hasThinking && (
          <div className="message-thinking">
            <button
              type="button"
              onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
              className="message-thinking-toggle"
              aria-expanded={isThinkingExpanded}
              aria-label={`${isThinkingExpanded ? 'Collapse' : 'Expand'} AI thinking process`}
            >
              {isThinkingExpanded ? (
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-3 h-3" aria-hidden="true" />
              )}
              <Brain className="w-3 h-3" aria-hidden="true" />
              <span>Thinking{isStreaming && !content ? '...' : ''}</span>
            </button>
            {isThinkingExpanded && (
              <div className="message-thinking-content">
                {formatContent(thinking, isStreaming && !content)}
              </div>
            )}
          </div>
        )}
        {/* Help card (rendered instead of message-text) */}
        {hasHelpCard && <HelpCard />}
        {/* Main content (not for tool messages - those are in collapsible block) */}
        {!isTool && !hasHelpCard && (content || !hasThinking) && (
          <div className="message-text">
            {isStreaming && !content && !hasThinking ? (
              <span className="thinking-indicator" aria-label="Barney is thinking">
                <span className="thinking-label">Barney is thinking</span>
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
              </span>
            ) : (
              formatContent(content, isStreaming && !!content)
            )}
          </div>
        )}
        {error && (
          <div className="message-error" role="alert">
            <AlertCircle className="w-3 h-3" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="message-error-suggestions">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => sendMessage(s.message)}
                className="message-error-suggestion"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {!isTool && (
          <div className="message-footer">
            <time className="message-timestamp" dateTime={new Date(message.timestamp).toISOString()}>
              {timeLabel}
            </time>
            {content && !isStreaming && (
              <button
                type="button"
                onClick={() => copyToClipboard(content)}
                className="message-copy-btn"
                aria-label={copied ? 'Copied' : 'Copy message'}
              >
                {copied
                  ? <Check className="w-3 h-3" aria-hidden="true" />
                  : <Copy className="w-3 h-3" aria-hidden="true" />}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
