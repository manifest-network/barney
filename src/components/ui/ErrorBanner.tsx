interface ErrorBannerProps {
  error: string;
  onRetry?: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  return (
    <div className="card-static p-4 border-error-500/50 bg-error-500/10">
      <span className="text-error">{error}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-4 text-primary-400 hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}
