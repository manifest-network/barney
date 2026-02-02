/**
 * Reusable copy button with visual feedback.
 * Shows a check icon when the value has been copied.
 */

import { Copy, Check } from 'lucide-react';
import type { CopyButtonProps } from './types';

export function CopyButton({
  value,
  copyToClipboard,
  isCopied,
  title = 'Copy',
  stopPropagation = false,
}: CopyButtonProps) {
  const copied = isCopied(value);
  return (
    <button
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        copyToClipboard(value);
      }}
      className={`lease-card-copy-btn ${copied ? 'copied' : ''}`}
      title={copied ? 'Copied!' : title}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}
