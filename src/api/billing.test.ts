import { describe, it, expect } from 'vitest';
import {
  LeaseState,
  leaseStateToString,
  leaseStateFromString,
  LEASE_STATE_MAP,
  LEASE_STATE_FILTERS,
} from './billing';

describe('leaseStateToString', () => {
  it('converts LEASE_STATE_ACTIVE to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_ACTIVE);
    expect(typeof result).toBe('string');
    expect(result).toContain('ACTIVE');
  });

  it('converts LEASE_STATE_PENDING to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_PENDING);
    expect(result).toContain('PENDING');
  });

  it('converts LEASE_STATE_CLOSED to string', () => {
    const result = leaseStateToString(LeaseState.LEASE_STATE_CLOSED);
    expect(result).toContain('CLOSED');
  });
});

describe('leaseStateFromString', () => {
  it('converts string back to enum value', () => {
    const str = leaseStateToString(LeaseState.LEASE_STATE_ACTIVE);
    expect(leaseStateFromString(str)).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  it('roundtrips all states through to/from', () => {
    const states = [
      LeaseState.LEASE_STATE_PENDING,
      LeaseState.LEASE_STATE_ACTIVE,
      LeaseState.LEASE_STATE_CLOSED,
      LeaseState.LEASE_STATE_REJECTED,
      LeaseState.LEASE_STATE_EXPIRED,
    ];
    for (const state of states) {
      expect(leaseStateFromString(leaseStateToString(state))).toBe(state);
    }
  });
});

describe('LEASE_STATE_MAP', () => {
  it('maps all expected string keys to LeaseState values', () => {
    expect(LEASE_STATE_MAP['pending']).toBe(LeaseState.LEASE_STATE_PENDING);
    expect(LEASE_STATE_MAP['active']).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(LEASE_STATE_MAP['closed']).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(LEASE_STATE_MAP['rejected']).toBe(LeaseState.LEASE_STATE_REJECTED);
    expect(LEASE_STATE_MAP['expired']).toBe(LeaseState.LEASE_STATE_EXPIRED);
  });

  it('has exactly 5 entries', () => {
    expect(Object.keys(LEASE_STATE_MAP)).toHaveLength(5);
  });
});

describe('LEASE_STATE_FILTERS', () => {
  it('starts with "all"', () => {
    expect(LEASE_STATE_FILTERS[0]).toBe('all');
  });

  it('includes all state map keys', () => {
    for (const key of Object.keys(LEASE_STATE_MAP)) {
      expect(LEASE_STATE_FILTERS).toContain(key);
    }
  });

  it('has 6 entries (all + 5 states)', () => {
    expect(LEASE_STATE_FILTERS).toHaveLength(6);
  });
});
