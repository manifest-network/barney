import { describe, it, expect } from 'vitest';
import { aggregateDnsKind } from './aggregateDnsKind';
import type { DnsStatusEntry } from '../../stores/aiStore';

function entry(kind: DnsStatusEntry['kind']): DnsStatusEntry {
  return { leaseUuid: 'l', customDomain: 'd', serviceName: '', kind };
}

describe('aggregateDnsKind', () => {
  it('returns active when all entries are active', () => {
    expect(aggregateDnsKind([entry('active'), entry('active')])).toBe('active');
  });

  it('returns failed when any entry has failed (worst-state-wins)', () => {
    expect(aggregateDnsKind([entry('active'), entry('failed'), entry('issuing_cert')])).toBe('failed');
  });

  it('returns pending_dns when any entry is pending and none failed', () => {
    expect(aggregateDnsKind([entry('active'), entry('pending_dns'), entry('issuing_cert')])).toBe('pending_dns');
  });

  it('returns issuing_cert when any entry is issuing and none worse', () => {
    expect(aggregateDnsKind([entry('active'), entry('issuing_cert')])).toBe('issuing_cert');
  });

  it('returns active for an empty list (no domains = nothing to flag)', () => {
    expect(aggregateDnsKind([])).toBe('active');
  });

  it('respects the failed > pending > issuing > active order', () => {
    expect(aggregateDnsKind([entry('pending_dns'), entry('failed')])).toBe('failed');
    expect(aggregateDnsKind([entry('issuing_cert'), entry('pending_dns')])).toBe('pending_dns');
  });
});
