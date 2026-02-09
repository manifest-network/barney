import { useEffect, useRef, type ReactNode } from 'react';

// Matches http(s):// URLs or bare host:port (IP or hostname with port number)
const URL_REGEX = /(https?:\/\/[^\s<>)"']+|\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b)/g;

/** Split text into plain strings and clickable links. */
function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }
    const href = raw.startsWith('http') ? raw : `http://${raw}`;
    parts.push(
      <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="message-link">
        {raw}
      </a>
    );
    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

interface StreamingTextProps {
  text: string;
  isStreaming?: boolean;
}

export function StreamingText({ text, isStreaming }: StreamingTextProps) {
  const prevLenRef = useRef(0);

  // Read ref during render (safe), but defer writes to useEffect
  // so StrictMode double-renders don't clobber the value.
  const prevLen = isStreaming ? prevLenRef.current : 0;

  useEffect(() => {
    prevLenRef.current = isStreaming ? text.length : 0;
  });

  if (isStreaming) {
    const oldText = text.slice(0, prevLen);
    const newText = text.slice(prevLen);

    return (
      <span className="streaming-text">
        {oldText && linkify(oldText)}
        {newText && <span className="streaming-chunk">{linkify(newText)}</span>}
        <span className="streaming-cursor">|</span>
      </span>
    );
  }

  return (
    <span className="streaming-text">
      {linkify(text)}
    </span>
  );
}
