import { useState } from 'react';
import { User, Bot, Wrench, AlertCircle, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../contexts/AIContext';
import { StreamingText } from './StreamingText';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, thinking, isStreaming, error, toolName } = message;
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [isToolExpanded, setIsToolExpanded] = useState(false);

  const isUser = role === 'user';
  const isTool = role === 'tool';
  const isAssistant = role === 'assistant';
  const hasThinking = isAssistant && thinking && thinking.length > 0;

  // Format content for display
  const formatContent = (text: string, streaming?: boolean) => {
    // Try to detect and format JSON
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        return (
          <pre className="message-json">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        );
      } catch {
        // Not valid JSON, display as text
      }
    }
    return <StreamingText text={text} isStreaming={streaming} />;
  };

  return (
    <div className={`message ${isUser ? 'message-user' : isTool ? 'message-tool' : 'message-assistant'}`}>
      <div className="message-avatar">
        {isUser ? (
          <User className="w-4 h-4" />
        ) : isTool ? (
          <Wrench className="w-4 h-4" />
        ) : (
          <Bot className="w-4 h-4" />
        )}
      </div>
      <div className="message-content">
        {/* Tool results (collapsible) */}
        {isTool && (
          <div className="message-tool-block">
            <button
              type="button"
              onClick={() => setIsToolExpanded(!isToolExpanded)}
              className="message-tool-toggle"
            >
              {isToolExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Wrench className="w-3 h-3" />
              <span>{toolName || 'Tool result'}</span>
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
            >
              {isThinkingExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Brain className="w-3 h-3" />
              <span>Thinking{isStreaming && !content ? '...' : ''}</span>
            </button>
            {isThinkingExpanded && (
              <div className="message-thinking-content">
                {formatContent(thinking, isStreaming && !content)}
              </div>
            )}
          </div>
        )}
        {/* Main content (not for tool messages - those are in collapsible block) */}
        {!isTool && (content || !hasThinking) && (
          <div className="message-text">
            {formatContent(content, isStreaming && !!content)}
          </div>
        )}
        {error && (
          <div className="message-error">
            <AlertCircle className="w-3 h-3" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
