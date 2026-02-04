import { CheckCircle, XCircle, Loader } from 'lucide-react';
import { cn } from '../../utils/cn';

interface ToolResultCardProps {
  toolName: string;
  isExecuting?: boolean;
  success?: boolean;
  data?: unknown;
  error?: string;
}

export function ToolResultCard({ toolName, isExecuting, success, data, error }: ToolResultCardProps) {
  return (
    <div className={cn('tool-result-card', error ? 'error' : success && 'success')}>
      <div className="tool-result-header">
        {isExecuting ? (
          <Loader className="w-4 h-4 animate-spin" />
        ) : success ? (
          <CheckCircle className="w-4 h-4 text-success" />
        ) : error ? (
          <XCircle className="w-4 h-4 text-error" />
        ) : null}
        <span className="tool-result-name">{toolName}</span>
      </div>
      {error && <div className="tool-result-error">{error}</div>}
      {data !== undefined && (
        <pre className="tool-result-data">
          {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
