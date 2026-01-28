interface StreamingTextProps {
  text: string;
  isStreaming?: boolean;
}

export function StreamingText({ text, isStreaming }: StreamingTextProps) {
  return (
    <span className="streaming-text">
      {text}
      {isStreaming && <span className="streaming-cursor">|</span>}
    </span>
  );
}
