/**
 * Integration test: end-to-end deploy flow
 *
 * Validates the full tool execution cycle:
 *   connect → deploy → list → status → stop → fund
 *
 * All API calls are mocked. Tests verify registry state, tool routing,
 * and progress reporting work together correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, executeConfirmedTool } from '../ai/toolExecutor';
import type { ToolExecutorOptions, PayloadAttachment } from '../ai/toolExecutor';
import type { AppRegistryAccess } from '../ai/toolExecutor/types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { AppEntry } from '../registry/appRegistry';
import type { DeployProgress } from '../ai/progress';
import { LeaseState } from '../api/billing';

// Mock all external API modules
vi.mock('../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/billing')>();
  return {
    ...actual,
    getLeasesByTenant: vi.fn(),
    getCreditAccount: vi.fn(),
    getCreditEstimate: vi.fn(),
    getLease: vi.fn(),
  };
});

vi.mock('../api/bank', () => ({
  getAllBalances: vi.fn(),
}));

vi.mock('../api/sku', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sku')>();
  return {
    ...actual,
    getProviders: vi.fn(),
    getSKUs: vi.fn(),
  };
});

vi.mock('../api/provider-api', () => ({
  getProviderHealth: vi.fn(),
  getLeaseConnectionInfo: vi.fn(),
  createSignMessage: vi.fn().mockReturnValue('sign-msg'),
  createAuthToken: vi.fn().mockReturnValue('auth-token'),
}));

vi.mock('../api/fred', () => ({
  getLeaseStatus: vi.fn(),
  pollLeaseUntilReady: vi.fn(),
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  cosmosTx: vi.fn(),
  cosmosQuery: vi.fn(),
}));

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('../ai/toolExecutor/utils', () => ({
  extractLeaseUuidFromTxResult: vi.fn(),
  uploadPayloadToProvider: vi.fn(),
  computePayloadHash: vi.fn(),
}));

import { getLeasesByTenant, getCreditAccount, getCreditEstimate, getLease } from '../api/billing';
import { getAllBalances } from '../api/bank';
import { getProviders, getSKUs } from '../api/sku';
import { getProviderHealth, getLeaseConnectionInfo } from '../api/provider-api';
import { pollLeaseUntilReady } from '../api/fred';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { extractLeaseUuidFromTxResult, uploadPayloadToProvider } from '../ai/toolExecutor/utils';

const ADDRESS = 'manifest1testaddr';
const CLIENT_MANAGER = {} as CosmosClientManager;
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_UUID = '660e8400-e29b-41d4-a716-446655440000';
const SKU_UUID = '770e8400-e29b-41d4-a716-446655440000';

function makeInMemoryRegistry(): AppRegistryAccess & { _store: AppEntry[] } {
  const _store: AppEntry[] = [];
  return {
    _store,
    getApps: () => [..._store],
    getApp: (_addr: string, name: string) => _store.find((a) => a.name === name) ?? null,
    findApp: (_addr: string, name: string) => {
      const lower = name.toLowerCase();
      return _store.find((a) => a.name.endsWith(`-${lower}`)) ?? _store.find((a) => a.name.includes(lower)) ?? null;
    },
    getAppByLease: (_addr: string, uuid: string) => _store.find((a) => a.leaseUuid === uuid) ?? null,
    addApp: (_addr: string, entry: AppEntry) => { _store.push(entry); return entry; },
    updateApp: (_addr: string, uuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>) => {
      const idx = _store.findIndex((a) => a.leaseUuid === uuid);
      if (idx === -1) return null;
      _store[idx] = { ..._store[idx], ...updates };
      return _store[idx];
    },
  };
}

describe('Deploy Flow Integration', () => {
  let registry: ReturnType<typeof makeInMemoryRegistry>;
  let progressEvents: DeployProgress[];
  let options: ToolExecutorOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = makeInMemoryRegistry();
    progressEvents = [];
    options = {
      clientManager: CLIENT_MANAGER,
      address: ADDRESS,
      appRegistry: registry,
      onProgress: (p: DeployProgress) => progressEvents.push(p),
      signArbitrary: vi.fn().mockResolvedValue({
        pub_key: { value: 'pubkey' },
        signature: 'sig',
      }),
    };
  });

  it('full deploy → list → status → stop cycle', async () => {
    // --- Setup mocks for deploy ---
    vi.mocked(getSKUs).mockResolvedValue([
      {
        uuid: SKU_UUID, name: 'docker-small', providerUuid: PROVIDER_UUID,
        basePrice: { denom: 'umfx', amount: '1000000' }, unit: 1, active: true,
        metaHash: new Uint8Array(),
      } as Awaited<ReturnType<typeof getSKUs>>[number],
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      {
        uuid: PROVIDER_UUID, address: 'manifest1provider', payoutAddress: 'manifest1payout',
        apiUrl: 'https://fred.example.com', active: true, metaHash: new Uint8Array(),
      } as Awaited<ReturnType<typeof getProviders>>[number],
    ]);
    vi.mocked(getProviderHealth).mockResolvedValue({ status: 'healthy', provider_uuid: PROVIDER_UUID });
    vi.mocked(getCreditEstimate).mockResolvedValue({
      currentBalance: [{ denom: 'umfx', amount: '100000000' }],
      totalRatePerSecond: [{ denom: 'umfx', amount: '1' }],
      estimatedDurationSeconds: 86400n,
      activeLeaseCount: 0n,
    } as Awaited<ReturnType<typeof getCreditEstimate>>);

    const payloadBytes = new TextEncoder().encode('version: "3"');
    const payload: PayloadAttachment = {
      filename: 'docker-compose.yml',
      bytes: payloadBytes,
      size: payloadBytes.byteLength,
      hash: 'abc123',
    };

    // Step 1: Deploy → should return confirmation
    const deployResult = await executeTool('deploy_app', { app_name: 'my-app', size: 'small' }, options, payload);
    expect(deployResult.success).toBe(true);
    expect(deployResult.requiresConfirmation).toBe(true);
    expect(deployResult.confirmationMessage).toContain('my-app');

    // Step 2: Confirm deploy
    vi.mocked(cosmosTx).mockResolvedValue({
      module: 'billing', subcommand: 'create-lease', height: '100',
      code: 0, transactionHash: 'tx-hash-1', rawLog: '', events: [],
    } as Awaited<ReturnType<typeof cosmosTx>>);
    vi.mocked(extractLeaseUuidFromTxResult).mockReturnValue(LEASE_UUID);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'uploaded' } });
    vi.mocked(pollLeaseUntilReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: ADDRESS,
      provider_uuid: PROVIDER_UUID,
      connection: {
        host: 'https://my-app.example.com',
        ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 12345 } },
      },
    });

    const confirmedResult = await executeConfirmedTool('deploy_app', { app_name: 'my-app', size: 'small' }, CLIENT_MANAGER, options, payload);
    expect(confirmedResult.success).toBe(true);

    // Verify app was added to registry
    expect(registry._store).toHaveLength(1);
    expect(registry._store[0].name).toBe('my-app');
    expect(registry._store[0].status).toBe('running');
    expect(registry._store[0].url).toBe('https://my-app.example.com:12345');

    // Verify progress events were emitted
    expect(progressEvents.length).toBeGreaterThan(0);
    const phases = progressEvents.map((p) => p.phase);
    expect(phases).toContain('creating_lease');
    expect(phases).toContain('uploading');
    expect(phases).toContain('provisioning');
    expect(phases).toContain('ready');

    // Step 3: List apps → should show the deployed app
    vi.mocked(getLeasesByTenant).mockResolvedValue([{ uuid: LEASE_UUID } as Awaited<ReturnType<typeof getLeasesByTenant>>[number]]);

    const listResult = await executeTool('list_apps', { state: 'running' }, options);
    expect(listResult.success).toBe(true);
    const listData = listResult.data as { apps: Array<{ name: string; status: string }>; count: number };
    expect(listData.count).toBe(1);
    expect(listData.apps[0].name).toBe('my-app');
    expect(listData.apps[0].status).toBe('running');

    // Step 4: App status
    vi.mocked(getLease).mockResolvedValue({ state: 2 } as Awaited<ReturnType<typeof getLease>>);

    const statusResult = await executeTool('app_status', { app_name: 'my-app' }, options);
    expect(statusResult.success).toBe(true);
    const statusData = statusResult.data as { name: string; status: string; chainState: string };
    expect(statusData.name).toBe('my-app');
    expect(statusData.status).toBe('running');
    expect(statusData.chainState).toBe('active');

    // Step 5: Stop app → should return confirmation
    const stopResult = await executeTool('stop_app', { app_name: 'my-app' }, options);
    expect(stopResult.success).toBe(true);
    expect(stopResult.requiresConfirmation).toBe(true);

    // Step 6: Confirm stop — use args from pendingAction (includes leaseUuid)
    const stopArgs = stopResult.pendingAction!.args;
    vi.mocked(cosmosTx).mockResolvedValue({
      module: 'billing', subcommand: 'close-lease', height: '101',
      code: 0, transactionHash: 'tx-hash-2', rawLog: '', events: [],
    } as Awaited<ReturnType<typeof cosmosTx>>);

    const confirmedStop = await executeConfirmedTool('stop_app', stopArgs, CLIENT_MANAGER, options);
    expect(confirmedStop.success).toBe(true);

    // Verify registry updated
    expect(registry._store[0].status).toBe('stopped');
  });

  it('fund credits flow', async () => {
    // Step 1: Fund → should return confirmation
    const fundResult = await executeTool('fund_credits', { amount: 50 }, options);
    expect(fundResult.success).toBe(true);
    expect(fundResult.requiresConfirmation).toBe(true);
    expect(fundResult.confirmationMessage).toContain('50');

    // Step 2: Confirm fund
    vi.mocked(cosmosTx).mockResolvedValue({
      module: 'billing', subcommand: 'fund-credit', height: '102',
      code: 0, transactionHash: 'tx-hash-fund', rawLog: '', events: [],
    } as Awaited<ReturnType<typeof cosmosTx>>);

    const confirmedFund = await executeConfirmedTool('fund_credits', { amount: 50 }, CLIENT_MANAGER, options);
    expect(confirmedFund.success).toBe(true);
  });

  it('get_balance flow', async () => {
    vi.mocked(getAllBalances).mockResolvedValue([{ denom: 'umfx', amount: '5000000' }]);
    vi.mocked(getCreditAccount).mockResolvedValue({
      creditAccount: { tenant: ADDRESS, creditAddress: 'credit-addr', activeLeaseCount: 1n, pendingLeaseCount: 0n, reservedAmounts: [] },
      balances: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
      availableBalances: [],
    } as Awaited<ReturnType<typeof getCreditAccount>>);
    vi.mocked(getCreditEstimate).mockResolvedValue({
      currentBalance: [{ denom: 'umfx', amount: '100000000' }],
      totalRatePerSecond: [{ denom: 'umfx', amount: '1' }],
      estimatedDurationSeconds: 86400n,
      activeLeaseCount: 1n,
    } as Awaited<ReturnType<typeof getCreditEstimate>>);

    const result = await executeTool('get_balance', {}, options);
    expect(result.success).toBe(true);
    const data = result.data as { credits: number; mfx_balance: number; running_apps: number };
    expect(data.mfx_balance).toBe(5);
    expect(data.running_apps).toBe(1);
  });

  it('returns error for unknown tool', async () => {
    const result = await executeTool('nonexistent', {}, options);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('returns error when wallet not connected', async () => {
    const noWalletOptions = { ...options, address: undefined };
    const result = await executeTool('list_apps', {}, noWalletOptions);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });
});
