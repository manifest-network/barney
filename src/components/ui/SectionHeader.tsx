import type { LucideIcon } from 'lucide-react';

interface SectionHeaderProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
}

export function SectionHeader({ title, description, icon: Icon, action }: SectionHeaderProps) {
  return (
    <div className="section-header">
      <div className="section-header-content">
        {Icon && <Icon className="section-header-icon" size={24} />}
        <div>
          <h2 className="section-header-title">{title}</h2>
          {description && <p className="section-header-description">{description}</p>}
        </div>
      </div>
      {action && <div className="section-header-action">{action}</div>}
    </div>
  );
}
