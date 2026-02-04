/**
 * AppCard — rendered on successful deploy_app.
 * Shows app name, URL, status, cost info with action buttons.
 */

import { memo } from 'react';
import { ExternalLink, Copy, Square, CheckCircle } from 'lucide-react';
import { useState } from 'react';
import { COPY_FEEDBACK_DURATION_MS } from '../../config/constants';

interface AppCardProps {
  name: string;
  url?: string;
  status: string;
  onStop?: () => void;
}

export const AppCard = memo(function AppCard({ name, url, status, onStop }: AppCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch {
      // Clipboard API may not be available
    }
  };

  return (
    <div className="app-card" role="article" aria-label={`App: ${name}`}>
      <div className="app-card__header">
        <CheckCircle className="w-5 h-5 text-success-400" aria-hidden="true" />
        <span className="app-card__name">{name}</span>
        <span className="app-card__status">{status}</span>
      </div>

      {url && (
        <div className="app-card__url">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="app-card__link"
          >
            {url}
            <ExternalLink className="w-3 h-3 ml-1" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="app-card__copy"
            aria-label={copied ? 'Copied' : 'Copy URL'}
          >
            {copied ? (
              <CheckCircle className="w-3.5 h-3.5 text-success-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      <div className="app-card__actions">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-sm"
          >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            Open
          </a>
        )}
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            className="btn btn-ghost btn-sm"
          >
            <Square className="w-3.5 h-3.5" aria-hidden="true" />
            Stop
          </button>
        )}
      </div>
    </div>
  );
});
