import { describe, it, expect } from 'vitest';
import { computeReDeployGate } from './reDeployGating';
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

describe('computeReDeployGate', () => {
  it('disabled with catalog-unavailable tooltip when tiers are not ready', () => {
    const gate = computeReDeployGate({
      size: 'docker-small',
      tiers: [],
      tiersReady: false,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe('Tier catalog unavailable');
  });

  it('disabled with tier-specific tooltip when stored size is no longer available', () => {
    const gate = computeReDeployGate({
      size: 'gpu-medium',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe("Original tier 'gpu-medium' is no longer available.");
  });

  it('enabled with default tooltip when tiers ready and size resolves', () => {
    const gate = computeReDeployGate({
      size: 'docker-small',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
    expect(gate.title).toBe('Re-deploy');
  });

  it('enabled when tiers ready and the app has no stored size', () => {
    const gate = computeReDeployGate({
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
    expect(gate.title).toBe('Re-deploy');
  });

  it('catalog-not-ready dominates over an also-unresolvable size', () => {
    const gate = computeReDeployGate({
      size: 'xxlarge',
      tiers: [],
      tiersReady: false,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toBe('Tier catalog unavailable');
  });

  it('accepts docker- prefix backward-compat for stored size hint', () => {
    const gate = computeReDeployGate({
      size: 'small',
      tiers: READY_TIERS,
      tiersReady: true,
    });
    expect(gate.disabled).toBe(false);
  });
});
