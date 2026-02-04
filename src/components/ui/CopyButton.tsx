/**
 * Reusable copy button with visual feedback.
 * Shows a check icon when the value has been copied.
 */

import { Copy, Check } from 'lucide-react';

export interface CopyButtonProps {
  value: string;
  copyToClipboard: (text: string, key?: string) => void;
  isCopied: (key: string) => boolean;
  /** Unique key for tracking feedback independently of the copied value */
  copyKey?: string;
  title?: string;
  stopPropagation?: boolean;
  className?: string;
}

export function CopyButton({
  value,
  copyToClipboard,
  isCopied,
  copyKey,
  title = 'Copy',
  stopPropagation = false,
  className = 'lease-card-copy-btn',
}: CopyButtonProps) {
  const key = copyKey ?? value;
  const copied = isCopied(key);
  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        copyToClipboard(value, copyKey);
      }}
      className={`${className} ${copied ? 'copied' : ''}`}
      title={copied ? 'Copied!' : title}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}
