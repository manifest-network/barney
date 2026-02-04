import { describe, it, expect } from 'vitest';
import { normalizeLeaseStateFilter } from './queries';
import { LeaseState } from '../../api/billing';

describe('normalizeLeaseStateFilter', () => {
  it('undefined input returns state: undefined', () => {
    const result = normalizeLeaseStateFilter(undefined);
    expect(result).toEqual({ state: undefined });
  });

  it('"all" returns state: undefined (case insensitive)', () => {
    expect(normalizeLeaseStateFilter('all')).toEqual({ state: undefined });
    expect(normalizeLeaseStateFilter('ALL')).toEqual({ state: undefined });
    expect(normalizeLeaseStateFilter('All')).toEqual({ state: undefined });
  });

  it('"active" maps to LEASE_STATE_ACTIVE', () => {
    const result = normalizeLeaseStateFilter('active');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_ACTIVE });
  });

  it('"pending" maps to LEASE_STATE_PENDING (case insensitive)', () => {
    expect(normalizeLeaseStateFilter('pending')).toEqual({ state: LeaseState.LEASE_STATE_PENDING });
    expect(normalizeLeaseStateFilter('PENDING')).toEqual({ state: LeaseState.LEASE_STATE_PENDING });
  });

  it('"closed" maps to LEASE_STATE_CLOSED', () => {
    const result = normalizeLeaseStateFilter('closed');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_CLOSED });
  });

  it('"rejected" maps to LEASE_STATE_REJECTED', () => {
    const result = normalizeLeaseStateFilter('rejected');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_REJECTED });
  });

  it('"expired" maps to LEASE_STATE_EXPIRED', () => {
    const result = normalizeLeaseStateFilter('expired');
    expect(result).toEqual({ state: LeaseState.LEASE_STATE_EXPIRED });
  });

  it('invalid filter returns error', () => {
    const result = normalizeLeaseStateFilter('nonexistent');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid state filter');
    expect(result.error).toContain('nonexistent');
  });

  it('empty string returns state: undefined', () => {
    const result = normalizeLeaseStateFilter('');
    expect(result).toEqual({ state: undefined });
  });
});
