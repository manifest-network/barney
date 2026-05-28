import { describe, it, expect } from 'vitest';
import { computeExampleAppGate } from './exampleAppGating';
import type { ResolvedSkuTier } from '../../api/skuTiers';

function tier(name: string): ResolvedSkuTier {
  return {
    skuName: name,
    skuUuid: name,
    providerUuid: 'p',
    cores: 1,
    ramMB: 1024,
    diskGB: 5,
    pricePerHour: 0.1,
    denomSymbol: 'PWR',
    unit: 1,
  };
}

const READY_TIERS = [tier('docker-micro'), tier('docker-small')];

describe('computeExampleAppGate', () => {
  it('returns disabled with the supplied tooltip when tiers are not ready', () => {
    const gate = computeExampleAppGate({
      size: 'small',
      tiers: [],
      tiersReady: false,
      notReadyTitle: 'Loading tier catalog…',
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe('Loading tier catalog…');
  });

  it('passes through an undefined notReadyTitle when none is supplied', () => {
    const gate = computeExampleAppGate({
      size: 'small',
      tiers: [],
      tiersReady: false,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBeUndefined();
  });

  it('returns enabled when tiers ready and size matches (canonical name)', () => {
    const gate = computeExampleAppGate({
      size: 'docker-small',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
    expect(gate.title).toBeUndefined();
  });

  it('returns enabled when tiers ready and size matches via docker- prefix fallback', () => {
    const gate = computeExampleAppGate({
      size: 'small',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
  });

  it('returns enabled when tiers ready and the app has no size hint', () => {
    const gate = computeExampleAppGate({
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
    expect(gate.title).toBeUndefined();
  });

  it('returns disabled with tier-specific tooltip when size does not resolve', () => {
    const gate = computeExampleAppGate({
      size: 'xxlarge',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe("Tier 'xxlarge' not available on this network.");
  });

  it('catalog-not-ready dominates over a size that would also fail to resolve', () => {
    // When both gates would fail, catalog-not-ready wins (cheaper signal +
    // matches user mental model: the whole panel is unavailable).
    const gate = computeExampleAppGate({
      size: 'xxlarge',
      tiers: [],
      tiersReady: false,
      notReadyTitle: 'Loading tier catalog…',
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe('Loading tier catalog…');
  });
});
