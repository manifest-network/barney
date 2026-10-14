import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderAllowlist,
  isProviderAllowed,
  parseProviderAllowlist,
  ProviderAllowlistError,
} from './providerAllowlist';

const runtime = vi.hoisted(() => ({ allowlist: '' }));
vi.mock('./runtimeConfig', async (original) => {
  const actual = await original<typeof import('./runtimeConfig')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, get PUBLIC_PROVIDER_ALLOWLIST() { return runtime.allowlist; } },
  };
});

const MAINNET = 'https://barney.manifest.network/api/fred';

beforeEach(() => { runtime.allowlist = ''; });

describe('parseProviderAllowlist', () => {
  it.each(['', '   '])('leaves every provider available when unset (%j)', (value) => {
    expect(parseProviderAllowlist(value)).toBeNull();
  });

  it('canonicalizes provider URLs the same way as the Fred compatibility map', () => {
    expect([...parseProviderAllowlist('["https://BARNEY.manifest.network:443/api/fred/", "https://other.example.com"]')!])
      .toEqual([MAINNET, 'https://other.example.com']);
  });

  it('treats an explicit empty list as allowing no provider', () => {
    expect(parseProviderAllowlist('[]')?.size).toBe(0);
  });

  it.each([
    MAINNET, '{"https://barney.manifest.network/api/fred":true}', 'null', '[1]',
    '["/api/fred"]', '["ftp://barney.manifest.network"]', '["not a url"]',
  ])('rejects %s', (value) => {
    expect(() => parseProviderAllowlist(value)).toThrow(ProviderAllowlistError);
  });

  it('keeps malformed values, which can contain credentials, out of the error', () => {
    expect(() => parseProviderAllowlist('["https://user:secret@"]')).toThrow(
      'PUBLIC_PROVIDER_ALLOWLIST must be a JSON array of absolute HTTP(S) provider URLs.',
    );
  });
});

describe('isProviderAllowed', () => {
  it('allows every provider, including an unknown URL, when unset', () => {
    expect(getProviderAllowlist()).toBeNull();
    expect(isProviderAllowed('https://api.aoraki.manifest.network/api/fred')).toBe(true);
    expect(isProviderAllowed('')).toBe(true);
  });

  it('allows only listed providers, matching significant paths and ignoring trailing slashes', () => {
    runtime.allowlist = JSON.stringify([MAINNET]);
    expect(isProviderAllowed(`${MAINNET}/`)).toBe(true);
    expect(isProviderAllowed('https://api.aoraki.manifest.network/api/fred')).toBe(false);
    expect(isProviderAllowed('https://barney.manifest.network/other')).toBe(false);
    expect(isProviderAllowed('')).toBe(false);
    expect(isProviderAllowed(undefined)).toBe(false);
  });

  it('fails closed for an invalid setting while reporting it to operations that need it', () => {
    runtime.allowlist = MAINNET;
    expect(isProviderAllowed(MAINNET)).toBe(false);
    expect(() => getProviderAllowlist()).toThrow(ProviderAllowlistError);
  });
});
