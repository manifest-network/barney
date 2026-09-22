import type { FredCompatibility, FredCompatibilityConfig } from '@manifest-network/manifest-sdk/deploy';
import { runtimeConfig } from './runtimeConfig';

/** ENG-976: dev runs Fred PR 240; providers not listed here retain SDK v0.13 rules. */
export const DEFAULT_FRED_COMPATIBILITY: Readonly<Record<string, FredCompatibility>> = Object.freeze({
  'https://s049-u002.manifest0.net/api/fred': 'pr240',
});

function providerKey(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // Keep malformed URLs (which can contain credentials) out of diagnostics.
  }
  throw new Error('PUBLIC_FRED_COMPATIBILITY requires absolute HTTP(S) provider URLs.');
}

function compatibility(value: unknown): FredCompatibility {
  if (value === 'v0.13' || value === 'pr240') return value;
  throw new Error('PUBLIC_FRED_COMPATIBILITY modes must be "v0.13" or "pr240".');
}

/** Validate once and freeze the selection used by preview and execution alike. */
export function parseFredCompatibility(value: string): FredCompatibilityConfig {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_FRED_COMPATIBILITY;
  if (trimmed === 'pr240' || trimmed === 'v0.13') return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('PUBLIC_FRED_COMPATIBILITY must be v0.13, pr240, or a JSON provider URL map.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PUBLIC_FRED_COMPATIBILITY must be v0.13, pr240, or a JSON provider URL map.');
  }
  const result: Record<string, FredCompatibility> = {};
  for (const [url, mode] of Object.entries(parsed)) {
    const key = providerKey(url);
    if (Object.hasOwn(result, key)) {
      throw new Error('PUBLIC_FRED_COMPATIBILITY contains duplicate provider URLs.');
    }
    result[key] = compatibility(mode);
  }
  return Object.freeze(result);
}

let configuredCompatibility: FredCompatibilityConfig | undefined;

/** Parse at the operation boundary so bad provider configuration produces an
 * actionable tool error instead of aborting the application's module imports. */
export function getFredCompatibility(): FredCompatibilityConfig {
  return configuredCompatibility ??= parseFredCompatibility(runtimeConfig.PUBLIC_FRED_COMPATIBILITY);
}

/** Match the SDK's canonical provider URL lookup, including significant paths. */
export function fredCompatibilityForProvider(
  providerUrl: string,
  config: FredCompatibilityConfig = getFredCompatibility(),
): FredCompatibility {
  return typeof config === 'string' ? config : config[providerKey(providerUrl)] ?? 'v0.13';
}
