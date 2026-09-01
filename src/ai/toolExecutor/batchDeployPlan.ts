/**
 * Canonical batch-deploy planning.
 *
 * Both batch entry points feed drafts into this module. The returned plan is
 * the complete consent artifact: exact manifest bytes (stored as immutable
 * UTF-8 strings), resolved SKUs/providers, per-app and aggregate rates, and
 * user-facing manifest summaries. Confirmed execution rebuilds the plan with
 * live prices and balance, verifies its hash, and only broadcasts when the
 * refreshed plan is identical to the one the user approved.
 */

import { validateManifest } from '@manifest-network/manifest-sdk/deploy';
import { getCreditAccount } from '../../api/billing';
import { DENOMS } from '../../api/config';
import { getProviders } from '../../api/sku';
import {
  resolveSizeOrCheapest,
  resolveSkuTiers,
  type ResolvedSkuTier,
} from '../../api/skuTiers';
import type { SkuSpecMap } from '../../config/skuSpecs';
import { validateAppName } from '../../registry/appRegistry';
import { validateAll } from '../../utils/customDomainValidation';
import { logError } from '../../utils/errors';
import { fromBaseUnits } from '../../utils/format';
import { MAX_PAYLOAD_SIZE, sha256, toHex } from '../../utils/hash';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import { withTimeout } from '../../api/utils';
import type { PayloadAttachment, ToolExecutorOptions } from './types';
import { validateManifestEnvNames } from './deployArgs';

export const BATCH_DEPLOY_PLAN_VERSION = 1 as const;

export interface BatchDeployEntry {
  app_name: string;
  payload: PayloadAttachment;
  /** Per-entry size is used by model-coalesced batches. UI-direct batches may
   * omit it and pass a shared size to `executeBatchDeploy` instead. */
  size?: string;
  customDomain?: string;
  customDomainServiceName?: string;
  customDomainWarning?: string;
}

export interface BatchDeployServiceSummary {
  /** Empty for the legacy single-service manifest shape. */
  name: string;
  image: string;
  ports: string[];
  /** Keys only. Values are deliberately excluded from confirmation data. */
  environmentKeys: string[];
}

export interface BatchDeployPlanEntry {
  app_name: string;
  size: string;
  skuUuid: string;
  providerUuid: string;
  providerUrl: string;
  resources: {
    cores: number;
    ramMB: number;
    diskGB: number;
  };
  manifest: string;
  manifestFilename: string;
  manifestSize: number;
  manifestHash: string;
  services: BatchDeployServiceSummary[];
  serviceNames: string[];
  serviceCount: number;
  pricePerServiceHour: number;
  totalPricePerHour: number;
  denomSymbol: string;
  customDomain?: string;
  customDomainServiceName?: string;
  customDomainWarning?: string;
}

export interface BatchDeployPlan {
  version: typeof BATCH_DEPLOY_PLAN_VERSION;
  entries: BatchDeployPlanEntry[];
  totalServiceCount: number;
  totalPricePerHour: number;
  denomSymbol: string;
  planHash: string;
}

export type BatchDeployPlanningResult =
  | {
      success: true;
      plan: BatchDeployPlan;
      confirmationMessage: string;
      creditBalance: number;
    }
  | { success: false; error: string };

export interface BatchDeployPlanningOptions {
  /** Query the chain for active SKUs and rebuild prices before planning. */
  refreshPrices?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePorts(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([port, options]) =>
    isRecord(options) && options.ingress === true ? `${port} (ingress)` : port
  );
}

function parseEnvironmentKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function summarizeManifest(parsed: Record<string, unknown>): BatchDeployServiceSummary[] {
  if (isRecord(parsed.services)) {
    return Object.entries(parsed.services).map(([name, raw]) => {
      const service = isRecord(raw) ? raw : {};
      return {
        name,
        image: typeof service.image === 'string' ? service.image : 'unknown',
        ports: parsePorts(service.ports),
        environmentKeys: parseEnvironmentKeys(service.env),
      };
    });
  }

  return [{
    name: '',
    image: typeof parsed.image === 'string' ? parsed.image : 'unknown',
    ports: parsePorts(parsed.ports),
    environmentKeys: parseEnvironmentKeys(parsed.env),
  }];
}

function specsFromTiers(tiers: readonly ResolvedSkuTier[]): SkuSpecMap {
  const specs: SkuSpecMap = {};
  for (const tier of tiers) {
    specs[tier.skuName] = {
      cores: tier.cores,
      ramMB: tier.ramMB,
      diskGB: tier.diskGB,
    };
  }
  return specs;
}

async function currentTiers(
  tiers: readonly ResolvedSkuTier[],
  refreshPrices: boolean,
): Promise<readonly ResolvedSkuTier[]> {
  if (!refreshPrices) return tiers;
  if (tiers.length === 0) return [];
  const refreshed = await withTimeout(
    resolveSkuTiers(specsFromTiers(tiers)),
    undefined,
    'Refresh batch deploy prices',
  );
  return refreshed.tiers;
}

function findAvailableCredits(account: Awaited<ReturnType<typeof getCreditAccount>>): number | null {
  if (!account?.balances) return null;
  for (const balance of account.balances) {
    if (balance.denom === DENOMS.PWR || balance.denom.includes('upwr')) {
      return fromBaseUnits(balance.amount, balance.denom);
    }
  }
  return 0;
}

function nextAvailableName(
  requested: string,
  address: string,
  usedNames: ReadonlySet<string>,
): { name?: string; error?: string } {
  const name = requested;
  let nameError = validateAppName(name, address);
  if (!nameError && !usedNames.has(name)) return { name };

  const baseName = name;
  for (let suffix = 2; suffix <= 99; suffix++) {
    const suffixText = `-${suffix}`;
    const candidate = `${baseName.slice(0, 32 - suffixText.length)}${suffixText}`;
    nameError = validateAppName(candidate, address);
    if (!nameError && !usedNames.has(candidate)) return { name: candidate };
  }

  return {
    error: nameError
      ? `Cannot deploy "${requested}": ${nameError}`
      : `Cannot find a unique app name for "${requested}".`,
  };
}

function planHashContent(plan: Omit<BatchDeployPlan, 'planHash'> | BatchDeployPlan): unknown {
  return {
    version: plan.version,
    entries: plan.entries.map((entry) => ({
      app_name: entry.app_name,
      size: entry.size,
      skuUuid: entry.skuUuid,
      providerUuid: entry.providerUuid,
      providerUrl: entry.providerUrl,
      resources: entry.resources,
      manifest: entry.manifest,
      manifestFilename: entry.manifestFilename,
      manifestSize: entry.manifestSize,
      manifestHash: entry.manifestHash,
      services: entry.services,
      serviceNames: entry.serviceNames,
      serviceCount: entry.serviceCount,
      pricePerServiceHour: entry.pricePerServiceHour,
      totalPricePerHour: entry.totalPricePerHour,
      denomSymbol: entry.denomSymbol,
      ...(entry.customDomain ? { customDomain: entry.customDomain } : {}),
      ...(entry.customDomainServiceName
        ? { customDomainServiceName: entry.customDomainServiceName }
        : {}),
      ...(entry.customDomainWarning
        ? { customDomainWarning: entry.customDomainWarning }
        : {}),
    })),
    totalServiceCount: plan.totalServiceCount,
    totalPricePerHour: plan.totalPricePerHour,
    denomSymbol: plan.denomSymbol,
  };
}

async function computePlanHash(plan: Omit<BatchDeployPlan, 'planHash'> | BatchDeployPlan): Promise<string> {
  return toHex(await sha256(JSON.stringify(planHashContent(plan))));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validServiceSummary(value: unknown): value is BatchDeployServiceSummary {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.image === 'string'
    && Array.isArray(value.ports)
    && value.ports.every((port) => typeof port === 'string')
    && Array.isArray(value.environmentKeys)
    && value.environmentKeys.every((key) => typeof key === 'string');
}

function validPlanEntry(value: unknown): value is BatchDeployPlanEntry {
  if (!isRecord(value) || !isRecord(value.resources)) return false;
  const optionalStrings = ['customDomain', 'customDomainServiceName', 'customDomainWarning'] as const;
  return typeof value.app_name === 'string'
    && typeof value.size === 'string'
    && typeof value.skuUuid === 'string'
    && typeof value.providerUuid === 'string'
    && typeof value.providerUrl === 'string'
    && typeof value.resources.cores === 'number'
    && typeof value.resources.ramMB === 'number'
    && typeof value.resources.diskGB === 'number'
    && typeof value.manifest === 'string'
    && typeof value.manifestFilename === 'string'
    && typeof value.manifestSize === 'number'
    && typeof value.manifestHash === 'string'
    && Array.isArray(value.services)
    && value.services.every(validServiceSummary)
    && Array.isArray(value.serviceNames)
    && value.serviceNames.every((name) => typeof name === 'string')
    && typeof value.serviceCount === 'number'
    && typeof value.pricePerServiceHour === 'number'
    && typeof value.totalPricePerHour === 'number'
    && typeof value.denomSymbol === 'string'
    && optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string');
}

export function isBatchDeployPlan(value: unknown): value is BatchDeployPlan {
  return isRecord(value)
    && value.version === BATCH_DEPLOY_PLAN_VERSION
    && Array.isArray(value.entries)
    && value.entries.length > 0
    && value.entries.every(validPlanEntry)
    && typeof value.totalServiceCount === 'number'
    && typeof value.totalPricePerHour === 'number'
    && typeof value.denomSymbol === 'string'
    && typeof value.planHash === 'string';
}

export async function verifyBatchDeployPlanIntegrity(plan: unknown): Promise<
  | { success: true; plan: BatchDeployPlan }
  | { success: false; error: string }
> {
  if (!isBatchDeployPlan(plan)) {
    return { success: false, error: 'Invalid batch deployment plan. No transaction was submitted.' };
  }
  const actual = await computePlanHash(plan);
  if (actual !== plan.planHash) {
    return {
      success: false,
      error: 'Batch deployment plan integrity check failed. The payload or displayed plan changed; no transaction was submitted.',
    };
  }
  return { success: true, plan };
}

export function batchPlanToEntries(plan: BatchDeployPlan): BatchDeployEntry[] {
  return plan.entries.map((entry) => {
    const bytes = new TextEncoder().encode(entry.manifest);
    return {
      app_name: entry.app_name,
      size: entry.size,
      payload: {
        bytes,
        filename: entry.manifestFilename,
        size: bytes.length,
        hash: entry.manifestHash,
      },
      ...(entry.customDomain ? { customDomain: entry.customDomain } : {}),
      ...(entry.customDomainServiceName
        ? { customDomainServiceName: entry.customDomainServiceName }
        : {}),
      ...(entry.customDomainWarning
        ? { customDomainWarning: entry.customDomainWarning }
        : {}),
    };
  });
}

export async function planBatchDeploy(
  drafts: readonly BatchDeployEntry[],
  options: ToolExecutorOptions,
  planningOptions: BatchDeployPlanningOptions = {},
): Promise<BatchDeployPlanningResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (drafts.length === 0) return { success: false, error: 'No apps to deploy' };

  let tiers: readonly ResolvedSkuTier[];
  try {
    tiers = await currentTiers(options.tiers, planningOptions.refreshPrices === true);
  } catch (error) {
    logError('batchDeployPlan.refreshPrices', error);
    return {
      success: false,
      error: 'Could not refresh current deployment prices. No transaction was submitted.',
    };
  }
  if (tiers.length === 0) {
    return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
  }

  let providers: Awaited<ReturnType<typeof getProviders>>;
  try {
    providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
  } catch (error) {
    logError('batchDeployPlan.fetchProviders', error);
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const usedNames = new Set<string>();
  const usedDomains = new Set<string>();
  const entries: BatchDeployPlanEntry[] = [];

  for (const draft of drafts) {
    const resolvedName = nextAvailableName(draft.app_name, address, usedNames);
    if (!resolvedName.name) return { success: false, error: resolvedName.error! };
    const name = resolvedName.name;
    usedNames.add(name);

    let manifest: string;
    try {
      manifest = new TextDecoder('utf-8', { fatal: true }).decode(draft.payload.bytes);
    } catch {
      return { success: false, error: `Cannot deploy "${name}": manifest is not valid UTF-8 text.` };
    }
    if (draft.payload.bytes.length === 0) {
      return { success: false, error: `Cannot deploy "${name}": manifest is empty.` };
    }
    if (draft.payload.bytes.length > MAX_PAYLOAD_SIZE) {
      return {
        success: false,
        error: `Cannot deploy "${name}": manifest exceeds the ${MAX_PAYLOAD_SIZE / 1024}KB limit.`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return { success: false, error: `Cannot deploy "${name}": manifest must be valid JSON.` };
    }
    const validation = validateManifest(parsed);
    if (!validation.valid) {
      return {
        success: false,
        error: `Cannot deploy "${name}": invalid manifest: ${validation.errors.join('; ')}`,
      };
    }
    const envError = validateManifestEnvNames(parsed);
    if (envError) return { success: false, error: `Cannot deploy "${name}": ${envError}` };

    const services = summarizeManifest(parsed as Record<string, unknown>);
    const serviceNames = services.map((service) => service.name).filter(Boolean);
    const serviceCount = services.length;

    const resolution = resolveSizeOrCheapest(draft.size, tiers);
    if (!resolution) {
      return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
    }
    const tier = resolution.tier;
    const provider = providers.find((candidate) => candidate.uuid === tier.providerUuid);
    if (!provider?.apiUrl) {
      return {
        success: false,
        error: `No available provider found for the ${tier.skuName} tier.`,
      };
    }

    let customDomain = draft.customDomain?.trim() ?? '';
    let customDomainServiceName = draft.customDomainServiceName?.trim() ?? '';
    let customDomainWarning = draft.customDomainWarning;
    if (customDomain) {
      customDomain = customDomain.toLowerCase().replace(/\.$/, '');
      if (usedDomains.has(customDomain)) {
        return { success: false, error: `Custom domain "${customDomain}" is repeated in this batch.` };
      }
      usedDomains.add(customDomain);

      const domainValidation = await validateAll(customDomain);
      if (domainValidation.error) return { success: false, error: domainValidation.error };
      customDomainWarning = domainValidation.warning;

      try {
        const existing = await withTimeout(
          queryLeaseByCustomDomain(customDomain),
          undefined,
          'queryLeaseByCustomDomain',
        );
        if (existing) {
          const heldByApp = appRegistry.getAppByLease(address, existing.leaseUuid);
          const friendly = heldByApp ? `"${heldByApp.name}"` : 'another lease';
          return {
            success: false,
            error: `"${customDomain}" is already attached to ${friendly}. Pick a different domain or detach it first.`,
          };
        }
      } catch (error) {
        logError('batchDeployPlan.queryLeaseByCustomDomain', error);
      }

      if (serviceNames.length > 1) {
        if (!customDomainServiceName || !serviceNames.includes(customDomainServiceName)) {
          return {
            success: false,
            error: `"${name}" is a multi-service stack — choose one of: ${serviceNames.join(', ')}.`,
          };
        }
      } else if (serviceNames.length === 1) {
        customDomainServiceName = serviceNames[0];
      } else {
        customDomainServiceName = '';
      }
    }

    const manifestHash = toHex(await sha256(draft.payload.bytes));
    entries.push({
      app_name: name,
      size: tier.skuName,
      skuUuid: tier.skuUuid,
      providerUuid: tier.providerUuid,
      providerUrl: provider.apiUrl,
      resources: { cores: tier.cores, ramMB: tier.ramMB, diskGB: tier.diskGB },
      manifest,
      manifestFilename: draft.payload.filename || 'manifest.json',
      manifestSize: draft.payload.bytes.length,
      manifestHash,
      services,
      serviceNames,
      serviceCount,
      pricePerServiceHour: tier.pricePerHour,
      totalPricePerHour: tier.pricePerHour * serviceCount,
      denomSymbol: tier.denomSymbol,
      ...(customDomain ? { customDomain } : {}),
      ...(customDomainServiceName ? { customDomainServiceName } : {}),
      ...(customDomainWarning ? { customDomainWarning } : {}),
    });
  }

  const denomSymbols = new Set(entries.map((entry) => entry.denomSymbol));
  if (denomSymbols.size !== 1) {
    return {
      success: false,
      error: 'Batch entries use different billing denominations and cannot be aggregated safely.',
    };
  }
  const denomSymbol = entries[0].denomSymbol;
  const totalServiceCount = entries.reduce((sum, entry) => sum + entry.serviceCount, 0);
  const totalPricePerHour = entries.reduce((sum, entry) => sum + entry.totalPricePerHour, 0);

  let creditBalance: number | null;
  try {
    const account = await withTimeout(getCreditAccount(address), undefined, 'Credit check');
    creditBalance = findAvailableCredits(account);
  } catch (error) {
    logError('batchDeployPlan.creditCheck', error);
    return {
      success: false,
      error: 'Could not verify aggregate credit balance. No transaction was submitted.',
    };
  }
  if (creditBalance === null) {
    return {
      success: false,
      error: 'Could not verify aggregate credit balance. No transaction was submitted.',
    };
  }
  if (totalPricePerHour > 0 && creditBalance < totalPricePerHour) {
    return {
      success: false,
      error: `Insufficient credits. You have ${creditBalance.toFixed(2)} credits but need at least ${totalPricePerHour.toFixed(2)} ${denomSymbol} for 1 hour of ${totalServiceCount} service${totalServiceCount === 1 ? '' : 's'} across ${entries.length} app${entries.length === 1 ? '' : 's'}.`,
    };
  }

  const withoutHash: Omit<BatchDeployPlan, 'planHash'> = {
    version: BATCH_DEPLOY_PLAN_VERSION,
    entries,
    totalServiceCount,
    totalPricePerHour,
    denomSymbol,
  };
  const plan: BatchDeployPlan = {
    ...withoutHash,
    planHash: await computePlanHash(withoutHash),
  };
  const runway = totalPricePerHour > 0 ? creditBalance / totalPricePerHour : Number.POSITIVE_INFINITY;
  const runwayWarning = runway < 24
    ? ` Warning: only ~${Math.floor(runway)}h of credits remaining at this rate.`
    : '';
  const names = entries.map((entry) => entry.app_name).join(', ');
  const confirmationMessage = `Deploy ${entries.length} app${entries.length === 1 ? '' : 's'} (${names}) for ${totalPricePerHour.toFixed(4)} ${denomSymbol}/hr total?${runwayWarning}`;

  return {
    success: true,
    plan: deepFreeze(plan),
    confirmationMessage,
    creditBalance,
  };
}
