import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="card p-8 text-center" role="alert">
          <div className="flex flex-col items-center gap-4">
            <div className="p-3 rounded-full bg-red-500/10">
              <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-primary mb-2">
                Something went wrong
              </h3>
              <p className="text-sm text-muted max-w-md">
                An unexpected error occurred. Please try again or refresh the page.
              </p>
              {this.state.error && (
                <details className="mt-4 text-left">
                  <summary className="text-xs text-muted cursor-pointer hover:text-secondary">
                    Technical details
                  </summary>
                  <pre className="mt-2 p-2 bg-surface-800 rounded text-xs text-red-400 overflow-auto max-h-32">
                    {this.state.error.message}
                  </pre>
                </details>
              )}
            </div>
            <button
              type="button"
              onClick={this.handleRetry}
              className="btn btn-primary btn-sm flex items-center gap-2"
            >
              <RefreshCw size={16} aria-hidden="true" />
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface TabErrorBoundaryProps {
  tabName: string;
  children: ReactNode;
}

export function TabErrorBoundary({ tabName, children }: TabErrorBoundaryProps) {
  return (
    <ErrorBoundary
      onError={(error) => {
        console.error(`Error in ${tabName}:`, error);
      }}
      fallback={
        <div className="card p-8 text-center" role="alert">
          <div className="flex flex-col items-center gap-4">
            <div className="p-3 rounded-full bg-red-500/10">
              <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-primary mb-2">
                Error loading {tabName}
              </h3>
              <p className="text-sm text-muted">
                There was a problem loading this section. Please refresh the page.
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn btn-primary btn-sm flex items-center gap-2"
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh Page
            </button>
          </div>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
