import { beforeEach, expect, it, vi } from 'vitest';
import { getCreditAccount } from '../../api/billing';
import { getProviders } from '../../api/sku';
import { resolveSkuTiers, type ResolvedSkuTier } from '../../api/skuTiers';
import * as appRegistry from '../../registry/appRegistry';
import { planBatchDeploy } from './batchDeployPlan';
import type { ToolExecutorOptions } from './types';

vi.mock('../../api/billing', () => ({ getCreditAccount: vi.fn() }));
vi.mock('../../api/sku', async (original) => ({
  ...await original<typeof import('../../api/sku')>(), getProviders: vi.fn(),
}));
vi.mock('../../api/skuTiers', async (original) => ({
  ...await original<typeof import('../../api/skuTiers')>(), resolveSkuTiers: vi.fn(),
}));

const tiers: ResolvedSkuTier[] = ['dev', 'legacy'].map((providerUuid) => ({
  providerUuid, skuName: providerUuid, skuUuid: `${providerUuid}-sku`,
  cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0, denomSymbol: 'PWR', unit: 0,
}));

function draft(size: string, manifest: string) {
  const bytes = new TextEncoder().encode(manifest);
  return { app_name: `${size}-app`, size, payload: { bytes, size: bytes.length, hash: '' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSkuTiers).mockResolvedValue({ tiers, denomSymbol: 'PWR' });
  vi.mocked(getProviders).mockResolvedValue([
    { uuid: 'dev', apiUrl: 'https://s049-u002.manifest0.net/api/fred/' },
    { uuid: 'legacy', apiUrl: 'https://provider.example.com' },
  ] as Awaited<ReturnType<typeof getProviders>>);
  vi.mocked(getCreditAccount).mockResolvedValue({ balances: [] } as unknown as Awaited<ReturnType<typeof getCreditAccount>>);
});

it('validates each batch preview against its selected provider contract', async () => {
  const manifest = '{"image":"nginx","labels":{"com.docker.compose.project":"tenant"}}';
  const options: ToolExecutorOptions = { address: 'manifest1tenant', appRegistry, clientManager: null, tiers };
  const result = await planBatchDeploy([
    draft('dev', manifest), draft('legacy', manifest),
  ], options, { allowPartialEntries: true });

  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  expect(result.plan.entries.map((entry) => entry.app_name)).toEqual(['legacy-app']);
  expect(result.rejectedEntries).toEqual([{
    draftIndex: 0, error: expect.stringContaining("reserved prefix 'com.docker.compose.'"),
  }]);
});

it('rejects duplicate keys in exact batch JSON before creating a confirmation', async () => {
  const options: ToolExecutorOptions = { address: 'manifest1tenant', appRegistry, clientManager: null, tiers };
  const result = await planBatchDeploy([draft('dev', '{"image":"nginx","image":"redis"}')], options);
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('duplicate') });
  expect(getCreditAccount).not.toHaveBeenCalled();
});
