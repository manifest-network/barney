import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="card-static empty-state">
      <div className="empty-state-illustration">
        <div className="empty-state-icon-wrapper">
          <Icon className="empty-state-icon" size={28} />
        </div>
      </div>
      <div className="empty-state-content">
        <h2 className="empty-state-title">{title}</h2>
        <p className="empty-state-description">{description}</p>
      </div>
      {action && (
        <div className="empty-state-action">
          <button onClick={action.onClick} className="btn btn-primary btn-lg btn-pill">
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
