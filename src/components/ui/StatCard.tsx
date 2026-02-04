/**
 * Reusable stat card component for displaying metrics
 */

import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

export interface StatCardProps {
  /** The main value to display */
  value: ReactNode;
  /** Label describing the value */
  label: ReactNode;
  /** Optional color class for the value (e.g., 'text-success', 'text-warning') */
  colorClass?: string;
}

export function StatCard({ value, label, colorClass }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className={cn('stat-value', colorClass)}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
