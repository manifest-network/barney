import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { logError } from '../../utils/errors';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary specifically for AI chat components.
 * Catches errors in the component tree and displays a recovery UI
 * instead of crashing the entire application.
 */
export class AIErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logError('AIErrorBoundary', { error, componentStack: errorInfo.componentStack });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="ai-error-boundary" role="alert" aria-live="assertive">
          <div className="ai-error-content">
            <AlertTriangle className="w-8 h-8 text-warning" aria-hidden="true" />
            <h3 className="ai-error-title">Something went wrong</h3>
            <p className="ai-error-message">
              The AI assistant encountered an error. This won't affect the rest of the application.
            </p>
            {this.state.error && (
              <details className="ai-error-details">
                <summary>Error details</summary>
                <pre tabIndex={0} aria-label="Error details">{this.state.error.message}</pre>
              </details>
            )}
            <button
              type="button"
              onClick={this.handleReset}
              className="ai-error-reset-btn"
              aria-label="Try again to reload the chat panel"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
