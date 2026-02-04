import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

interface SidebarItemProps {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

export function SidebarItem({ icon: Icon, label, isActive, onClick }: SidebarItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('sidebar-item', isActive && 'active')}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon className="sidebar-item-icon" size={20} />
      <span>{label}</span>
    </button>
  );
}
