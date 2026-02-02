/**
 * Lease state display utilities
 */

import { LeaseState } from '../api/billing';

/**
 * Badge CSS classes for each lease state.
 * TypeScript enforces completeness - adding a new state to manifestjs will cause a compile error.
 */
export const LEASE_STATE_BADGE_CLASSES: Record<LeaseState, string> = {
  [LeaseState.LEASE_STATE_UNSPECIFIED]: 'badge badge-neutral',
  [LeaseState.LEASE_STATE_PENDING]: 'badge badge-warning',
  [LeaseState.LEASE_STATE_ACTIVE]: 'badge badge-success',
  [LeaseState.LEASE_STATE_CLOSED]: 'badge badge-neutral',
  [LeaseState.LEASE_STATE_REJECTED]: 'badge badge-error',
  [LeaseState.LEASE_STATE_EXPIRED]: 'badge badge-neutral',
  [LeaseState.UNRECOGNIZED]: 'badge badge-neutral',
};

/**
 * Human-readable labels for each lease state.
 * TypeScript enforces completeness - adding a new state to manifestjs will cause a compile error.
 */
export const LEASE_STATE_LABELS: Record<LeaseState, string> = {
  [LeaseState.LEASE_STATE_UNSPECIFIED]: 'Unspecified',
  [LeaseState.LEASE_STATE_PENDING]: 'Pending',
  [LeaseState.LEASE_STATE_ACTIVE]: 'Active',
  [LeaseState.LEASE_STATE_CLOSED]: 'Closed',
  [LeaseState.LEASE_STATE_REJECTED]: 'Rejected',
  [LeaseState.LEASE_STATE_EXPIRED]: 'Expired',
  [LeaseState.UNRECOGNIZED]: 'Unknown',
};

/**
 * Color classes for lease state values (for stat cards, etc.).
 * TypeScript enforces completeness - adding a new state to manifestjs will cause a compile error.
 */
export const LEASE_STATE_COLORS: Record<LeaseState, string> = {
  [LeaseState.LEASE_STATE_UNSPECIFIED]: 'text-muted',
  [LeaseState.LEASE_STATE_PENDING]: 'text-warning',
  [LeaseState.LEASE_STATE_ACTIVE]: 'text-success',
  [LeaseState.LEASE_STATE_CLOSED]: 'text-muted',
  [LeaseState.LEASE_STATE_REJECTED]: 'text-error',
  [LeaseState.LEASE_STATE_EXPIRED]: 'text-muted',
  [LeaseState.UNRECOGNIZED]: 'text-muted',
};

/**
 * Filter state type for lease filtering UI.
 * Used to group lease states into filterable categories.
 */
export type LeaseFilterState = 'all' | 'pending' | 'active' | 'closed' | 'rejected';

/**
 * Maps LeaseState enum values to filter state categories.
 * Expired leases are grouped with closed for filtering purposes.
 * TypeScript enforces completeness - adding a new state to manifestjs will cause a compile error.
 */
export const LEASE_STATE_TO_FILTER: Record<LeaseState, LeaseFilterState> = {
  [LeaseState.LEASE_STATE_PENDING]: 'pending',
  [LeaseState.LEASE_STATE_ACTIVE]: 'active',
  [LeaseState.LEASE_STATE_CLOSED]: 'closed',
  [LeaseState.LEASE_STATE_REJECTED]: 'rejected',
  [LeaseState.LEASE_STATE_EXPIRED]: 'closed', // Group expired with closed
  [LeaseState.LEASE_STATE_UNSPECIFIED]: 'all',
  [LeaseState.UNRECOGNIZED]: 'all',
};
