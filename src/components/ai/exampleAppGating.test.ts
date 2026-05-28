import { describe, it, expect } from 'vitest';
import { computeExampleAppGate, getDeployExampleRejection } from './exampleAppGating';
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

describe('getDeployExampleRejection', () => {
  // Sister of `computeExampleAppGate` for the typed-command path
  // ("deploy tetris" / "deploy redis" through doSubmit). The button-click
  // path uses tooltips; the typed path can't, so it surfaces the rejection
  // as a chat message instead.

  it('returns null when tiers are ready and size resolves — happy path', () => {
    expect(getDeployExampleRejection({
      size: 'docker-micro',
      tiers: READY_TIERS,
      tiersReady: true,
      phase: 'ready',
      errorMessage: null,
    })).toBeNull();
  });

  it('returns null when tiers are ready and the app has no size hint', () => {
    expect(getDeployExampleRejection({
      tiers: READY_TIERS,
      tiersReady: true,
      phase: 'ready',
      errorMessage: null,
    })).toBeNull();
  });

  it('returns loading wording when tiers are not ready (phase=loading)', () => {
    const msg = getDeployExampleRejection({
      size: 'small',
      tiers: [],
      tiersReady: false,
      phase: 'loading',
      errorMessage: null,
    });
    expect(msg).toBe('Deploy unavailable: tier catalog is still loading. Please wait a moment and try again.');
  });

  it('returns loading wording when tiers are not ready (phase=idle)', () => {
    const msg = getDeployExampleRejection({
      size: 'small',
      tiers: [],
      tiersReady: false,
      phase: 'idle',
      errorMessage: null,
    });
    expect(msg).toBe('Deploy unavailable: tier catalog is still loading. Please wait a moment and try again.');
  });

  it('returns error wording with the underlying error when phase=error', () => {
    const msg = getDeployExampleRejection({
      size: 'small',
      tiers: [],
      tiersReady: false,
      phase: 'error',
      errorMessage: 'chain unreachable',
    });
    expect(msg).toBe('Deploy unavailable: chain unreachable. Click Retry above.');
  });

  it('error wording falls back to a generic phrase when errorMessage is null', () => {
    const msg = getDeployExampleRejection({
      size: 'small',
      tiers: [],
      tiersReady: false,
      phase: 'error',
      errorMessage: null,
    });
    expect(msg).toBe('Deploy unavailable: tier catalog not ready. Click Retry above.');
  });

  it('returns tier-specific rejection when stored size does not resolve', () => {
    const msg = getDeployExampleRejection({
      size: 'gpu-xlarge',
      tiers: READY_TIERS,
      tiersReady: true,
      phase: 'ready',
      errorMessage: null,
    });
    expect(msg).toBe("Tier 'gpu-xlarge' is not available on this network.");
  });

  it('catalog-not-ready dominates over an also-unresolvable size', () => {
    // If catalog hasn't loaded, the user can't tell if the size is bad or
    // the catalog is bad — surface the higher-level catalog message so the
    // typed-path reason matches what the button-tooltip side would say.
    const msg = getDeployExampleRejection({
      size: 'docker-xxlarge',
      tiers: [],
      tiersReady: false,
      phase: 'loading',
      errorMessage: null,
    });
    expect(msg).toMatch(/loading/);
  });
});
