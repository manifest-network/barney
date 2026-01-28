import type { UseAutoRefreshReturn } from '../../hooks/useAutoRefresh';

interface AutoRefreshIndicatorProps {
  autoRefresh: UseAutoRefreshReturn;
  intervalSeconds: number;
}

export function AutoRefreshIndicator({ autoRefresh, intervalSeconds }: AutoRefreshIndicatorProps) {
  const { isEnabled, toggle, isRefreshing, lastRefresh, refresh } = autoRefresh;

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        onClick={refresh}
        disabled={isRefreshing}
        className="btn btn-secondary btn-sm"
      >
        {isRefreshing ? 'Refreshing...' : 'Refresh'}
      </button>

      <div className="flex items-center gap-2">
        <button
          onClick={toggle}
          className={`toggle ${isEnabled ? 'active' : ''}`}
          title={isEnabled ? 'Disable auto-refresh' : 'Enable auto-refresh'}
        >
          <span className="toggle-knob" />
        </button>
        <span className="text-muted">
          Auto {isEnabled ? `(${intervalSeconds}s)` : 'off'}
        </span>
      </div>

      {isRefreshing && (
        <span className="flex items-center gap-1 text-primary-400">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </span>
      )}

      {lastRefresh && !isRefreshing && (
        <span className="text-dim" title={`Last updated: ${formatTime(lastRefresh)}`}>
          {formatTime(lastRefresh)}
        </span>
      )}
    </div>
  );
}
