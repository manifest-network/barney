/**
 * Filter tabs for lease state filtering.
 */

import type { FilterTabsProps } from './types';
import type { LeaseFilterState } from '../../../utils/leaseState';
import { cn } from '../../../utils/cn';

const FILTERS: { key: LeaseFilterState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'closed', label: 'Closed' },
  { key: 'rejected', label: 'Rejected' },
];

export function FilterTabs({ activeFilter, onChange, counts }: FilterTabsProps) {
  return (
    <div className="filter-tabs">
      {FILTERS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn('filter-tab', activeFilter === key && 'active')}
          aria-pressed={activeFilter === key}
          data-state={key}
          data-has-items={counts[key] > 0 ? 'true' : 'false'}
        >
          {label}
          <span className="filter-tab-count">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}
