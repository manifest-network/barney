import { describe, it, expect } from 'vitest';
import {
  LEASE_STATE_BADGE_CLASSES,
  LEASE_STATE_LABELS,
  LEASE_STATE_COLORS,
  LEASE_STATE_TO_FILTER,
  type LeaseFilterState,
} from './leaseState';
import { LeaseState } from '../api/billing';

describe('LEASE_STATE_BADGE_CLASSES', () => {
  it('has classes for all lease states', () => {
    const states = [
      LeaseState.LEASE_STATE_UNSPECIFIED,
      LeaseState.LEASE_STATE_PENDING,
      LeaseState.LEASE_STATE_ACTIVE,
      LeaseState.LEASE_STATE_CLOSED,
      LeaseState.LEASE_STATE_REJECTED,
      LeaseState.LEASE_STATE_EXPIRED,
      LeaseState.UNRECOGNIZED,
    ];

    for (const state of states) {
      expect(LEASE_STATE_BADGE_CLASSES[state]).toBeDefined();
      expect(LEASE_STATE_BADGE_CLASSES[state]).toContain('badge');
    }
  });

  it('uses warning badge for pending', () => {
    expect(LEASE_STATE_BADGE_CLASSES[LeaseState.LEASE_STATE_PENDING]).toContain('badge-warning');
  });

  it('uses success badge for active', () => {
    expect(LEASE_STATE_BADGE_CLASSES[LeaseState.LEASE_STATE_ACTIVE]).toContain('badge-success');
  });

  it('uses error badge for rejected', () => {
    expect(LEASE_STATE_BADGE_CLASSES[LeaseState.LEASE_STATE_REJECTED]).toContain('badge-error');
  });

  it('uses neutral badge for closed and expired', () => {
    expect(LEASE_STATE_BADGE_CLASSES[LeaseState.LEASE_STATE_CLOSED]).toContain('badge-neutral');
    expect(LEASE_STATE_BADGE_CLASSES[LeaseState.LEASE_STATE_EXPIRED]).toContain('badge-neutral');
  });
});

describe('LEASE_STATE_LABELS', () => {
  it('has human-readable labels for all lease states', () => {
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_PENDING]).toBe('Pending');
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_ACTIVE]).toBe('Active');
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_CLOSED]).toBe('Closed');
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_REJECTED]).toBe('Rejected');
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_EXPIRED]).toBe('Expired');
    expect(LEASE_STATE_LABELS[LeaseState.LEASE_STATE_UNSPECIFIED]).toBe('Unspecified');
    expect(LEASE_STATE_LABELS[LeaseState.UNRECOGNIZED]).toBe('Unknown');
  });
});

describe('LEASE_STATE_COLORS', () => {
  it('has color classes for all lease states', () => {
    expect(LEASE_STATE_COLORS[LeaseState.LEASE_STATE_PENDING]).toBe('text-warning');
    expect(LEASE_STATE_COLORS[LeaseState.LEASE_STATE_ACTIVE]).toBe('text-success');
    expect(LEASE_STATE_COLORS[LeaseState.LEASE_STATE_REJECTED]).toBe('text-error');
    expect(LEASE_STATE_COLORS[LeaseState.LEASE_STATE_CLOSED]).toBe('text-muted');
    expect(LEASE_STATE_COLORS[LeaseState.LEASE_STATE_EXPIRED]).toBe('text-muted');
  });
});

describe('LEASE_STATE_TO_FILTER', () => {
  it('maps lease states to filter categories', () => {
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_PENDING]).toBe('pending');
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_ACTIVE]).toBe('active');
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_CLOSED]).toBe('closed');
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_REJECTED]).toBe('rejected');
  });

  it('groups expired with closed', () => {
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_EXPIRED]).toBe('closed');
  });

  it('maps unspecified and unrecognized to all', () => {
    expect(LEASE_STATE_TO_FILTER[LeaseState.LEASE_STATE_UNSPECIFIED]).toBe('all');
    expect(LEASE_STATE_TO_FILTER[LeaseState.UNRECOGNIZED]).toBe('all');
  });

  it('filter values are valid LeaseFilterState', () => {
    const validFilters: LeaseFilterState[] = ['all', 'pending', 'active', 'closed', 'rejected'];

    for (const state of Object.values(LeaseState)) {
      if (typeof state === 'number') {
        const filter = LEASE_STATE_TO_FILTER[state];
        expect(validFilters).toContain(filter);
      }
    }
  });
});
