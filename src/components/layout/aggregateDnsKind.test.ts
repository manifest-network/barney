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

  // Regression: un-probed domains (no entry in dnsStatuses yet) must be
  // treated as pending so a multi-domain app's dot doesn't flash green
  // when only one of N has been probed. The sidebar callsite now passes
  // the full report array — including undefined — into the aggregator,
  // rather than filtering them out and letting worst-state-wins lose
  // its conservative arm. See PR #93 Copilot 3236552129.
  it('treats undefined entries as pending_dns (un-probed)', () => {
    expect(aggregateDnsKind([entry('active'), undefined])).toBe('pending_dns');
  });

  it('prefers failed over undefined when both present', () => {
    expect(aggregateDnsKind([entry('failed'), undefined, entry('active')])).toBe('failed');
  });

  it('returns active only when every entry is defined and active', () => {
    // All-defined-active baseline preserved.
    expect(aggregateDnsKind([entry('active'), entry('active')])).toBe('active');
    // A single undefined among actives pulls the result back to pending.
    expect(aggregateDnsKind([entry('active'), undefined, entry('active')])).toBe('pending_dns');
  });
});
