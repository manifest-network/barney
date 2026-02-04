/**
 * Reusable copy button with visual feedback.
 * Shows a check icon when the value has been copied.
 */

import { Copy, Check } from 'lucide-react';

export interface CopyButtonProps {
  value: string;
  copyToClipboard: (text: string) => void;
  isCopied: (text: string) => boolean;
  title?: string;
  stopPropagation?: boolean;
  className?: string;
}

export function CopyButton({
  value,
  copyToClipboard,
  isCopied,
  title = 'Copy',
  stopPropagation = false,
  className = 'lease-card-copy-btn',
}: CopyButtonProps) {
  const copied = isCopied(value);
  return (
    <button
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        copyToClipboard(value);
      }}
      className={`${className} ${copied ? 'copied' : ''}`}
      title={copied ? 'Copied!' : title}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}
