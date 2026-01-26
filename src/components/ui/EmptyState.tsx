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
    <div className="card-static p-12 text-center">
      <div className="empty-state-icon-wrapper">
        <Icon className="empty-state-icon" size={48} />
      </div>
      <h2 className="empty-state-title">{title}</h2>
      <p className="empty-state-description">{description}</p>
      {action && (
        <button onClick={action.onClick} className="btn btn-primary btn-lg btn-pill mt-6">
          {action.label}
        </button>
      )}
    </div>
  );
}
