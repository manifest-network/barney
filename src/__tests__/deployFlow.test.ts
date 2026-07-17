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
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
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
}));

vi.mock('../api/fred', () => ({
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
}));

vi.mock('@manifest-network/manifest-sdk/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/chain')>()),
  cosmosTx: vi.fn(),
  cosmosQuery: vi.fn(),
}));

// C2 (ENG-279): the confirmed deploy path delegates the create-lease → upload →
// poll spine to deployManifest. ENG-483: it's imported from the SDK deploy
// facade, so mock there. Spread the original facade; manifest.ts's
// buildManifest/mergeManifest come from -fred (unmocked, real).
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal()),
  deployManifest: vi.fn(),
  stopApp: vi.fn(),
  appStatus: vi.fn(),
}));

vi.mock('../api/readClient', () => ({ getReadClient: vi.fn() }));

const mockGetBalance = vi.fn();

vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

import { getLeasesByTenant, getCreditEstimate } from '../api/billing';
import { getProviders, getSKUs } from '../api/sku';
import { getProviderHealth, getLeaseConnectionInfo } from '../api/provider-api';
import { cosmosTx } from '@manifest-network/manifest-sdk/chain';
import { deployManifest, stopApp, appStatus } from '@manifest-network/manifest-sdk/deploy';
import { getReadClient } from '../api/readClient';

const ADDRESS = 'manifest1testaddr';
const MOCK_QUERY_CLIENT = {} as Awaited<ReturnType<CosmosClientManager['getQueryClient']>>;
const CLIENT_MANAGER = {
  getQueryClient: vi.fn().mockResolvedValue(MOCK_QUERY_CLIENT),
} as unknown as CosmosClientManager;
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
      signing: {
        providerAuth: { providerToken: vi.fn(), leaseDataToken: vi.fn() },
        authTokens: {
          getAuthToken: vi.fn().mockResolvedValue('auth-token'),
          getLeaseDataAuthToken: vi.fn().mockResolvedValue('lease-data-auth-token'),
        },
      },
      tiers: [
        { skuName: 'docker-micro', skuUuid: 'sku-micro', providerUuid: PROVIDER_UUID, cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
        { skuName: 'docker-small', skuUuid: SKU_UUID, providerUuid: PROVIDER_UUID, cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
      ],
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

    // Must be valid JSON — the deploy SDK JSON.parses the manifest string,
    // and the plan-phase guard (§3.9) now rejects non-JSON file uploads
    // (e.g. raw docker-compose YAML) before reaching confirmation.
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ image: 'nginx', port: '80' }));
    const payload: PayloadAttachment = {
      filename: 'docker-compose.json',
      bytes: payloadBytes,
      size: payloadBytes.byteLength,
      hash: 'abc123',
    };

    // Step 1: Deploy → should return confirmation
    const deployResult = await executeTool('deploy_app', { app_name: 'my-app', size: 'small' }, options, payload);
    expect(deployResult.success).toBe(true);
    expect(deployResult.requiresConfirmation).toBe(true);
    expect(deployResult.confirmationMessage).toContain('my-app');

    // Step 2: Confirm deploy — C2: the spine is deployManifest. buildFredAuthCtx
    // needs the read client's query; deployManifest fires onLeaseCreated (registry
    // addApp + uploading) + a provisioning tick, then resolves with the connection
    // used for URL shaping.
    vi.mocked(getReadClient).mockResolvedValue(
      { query: {} } as unknown as Awaited<ReturnType<typeof getReadClient>>,
    );
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.(LEASE_UUID, 'https://fred.example.com');
      opts?.pollOptions?.onProgress?.({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'provisioning' } as never);
      return {
        lease_uuid: LEASE_UUID,
        provider_uuid: PROVIDER_UUID,
        provider_url: 'https://fred.example.com',
        state: LeaseState.LEASE_STATE_ACTIVE,
        connection: {
          host: 'https://my-app.example.com',
          ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 12345 } },
        },
      } as never;
    });
    // Retained old-spine mock — still used by the stop step below, harmless
    // for deploy now that deployManifest owns the spine.
    vi.mocked(cosmosTx).mockResolvedValue({
      module: 'billing', subcommand: 'create-lease', height: '100',
      code: 0, transactionHash: 'tx-hash-1', rawLog: '', events: [],
    } as Awaited<ReturnType<typeof cosmosTx>>);
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
    expect(registry._store[0].url).toBe('my-app.example.com:12345');

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

    // Step 4: App status — signer present, so it routes through the SDK
    // appStatus primitive (ENG-312 Phase 5). getReadClient is already mocked
    // above so buildBarneyCtx resolves its ctx.query.
    vi.mocked(appStatus).mockResolvedValue({
      lease_uuid: LEASE_UUID,
      chainState: { state: 2, providerUuid: PROVIDER_UUID, createdAt: '', closedAt: undefined, items: [] },
      fredStatus: { state: 2 },
    } as unknown as Awaited<ReturnType<typeof appStatus>>);

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

    // Step 6: Confirm stop — use args from pendingAction (includes leaseUuid).
    // stop_app now delegates to the SDK's stopApp primitive (ENG-312 Phase 4).
    const stopArgs = stopResult.pendingAction!.args;
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as Awaited<ReturnType<typeof stopApp>>);

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
    vi.mocked(getReadClient).mockResolvedValue(
      { getBalance: mockGetBalance } as unknown as Awaited<ReturnType<typeof getReadClient>>,
    );
    mockGetBalance.mockResolvedValue({
      balances: [{ denom: 'umfx', amount: '5000000' }],
      current_balance: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
      spending_per_hour: [{ denom: 'umfx', amount: '3600' }],
      hours_remaining: '24.0',
      running_apps: '1',
      credits: {
        active_leases: '1',
        pending_leases: '0',
        reserved_amounts: [],
        balances: [{ denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr', amount: '100000000' }],
        available_balances: [],
      },
    });

    const result = await executeTool('get_balance', {}, options);
    expect(result.success).toBe(true);
    const data = result.data as { credits: number; running_apps: number };
    expect(data.credits).toBe(100);
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
