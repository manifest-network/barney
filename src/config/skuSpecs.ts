/**
 * Schema-validated parser for the `PUBLIC_SKU_SPECS` env var.
 *
 * The chain supplies SKU names and prices; this env var supplies the
 * accompanying CPU/RAM/disk specs. Different networks ship different specs,
 * so the resolved tier list is the chain ∩ env intersection.
 *
 * On any parse error or schema violation, returns an empty map and logs to
 * console. The caller (loadSkuTiers action) treats an empty spec map as
 * "no tiers usable" and surfaces that as an error to deploy surfaces.
 */

import { logError } from '../utils/errors';

export interface SkuSpec {
  cores: number;
  ramMB: number;
  diskGB: number;
}

export type SkuSpecMap = Record<string, SkuSpec>;

function isValidSpec(value: unknown): value is SkuSpec {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.cores === 'number' && Number.isFinite(v.cores) && v.cores > 0 &&
    typeof v.ramMB === 'number' && Number.isFinite(v.ramMB) && v.ramMB > 0 &&
    typeof v.diskGB === 'number' && Number.isFinite(v.diskGB) && v.diskGB > 0
  );
}

export function parseSkuSpecs(raw: string): SkuSpecMap {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    logError('skuSpecs.parseSkuSpecs.json', error);
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logError('skuSpecs.parseSkuSpecs.shape', new Error('PUBLIC_SKU_SPECS must be a JSON object'));
    return {};
  }

  const out: SkuSpecMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValidSpec(value)) {
      out[key] = { cores: value.cores, ramMB: value.ramMB, diskGB: value.diskGB };
    } else {
      logError('skuSpecs.parseSkuSpecs.entry', new Error(`Invalid SKU spec for "${key}"`));
    }
  }
  return out;
}
