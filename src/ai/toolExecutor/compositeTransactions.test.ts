import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveAppName,
  executeDeployApp,
  executeConfirmedDeployApp,
  executeStopApp,
  executeConfirmedStopApp,
  executeFundCredits,
  executeConfirmedFundCredits,
  executeCosmosTransaction,
  executeConfirmedCosmosTx,
} from './compositeTransactions';
import type { ToolExecutorOptions, AppRegistryAccess, PayloadAttachment } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { AppEntry } from '../../registry/appRegistry';
import { LeaseState } from '../../api/billing';

// Mock external modules
vi.mock('../../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/billing')>();
  return {
    ...actual,
    getCreditEstimate: vi.fn(),
    getLease: vi.fn(),
  };
});

vi.mock('../../api/sku', () => ({
  getProviders: vi.fn(),
  getSKUs: vi.fn(),
}));

vi.mock('../../api/provider-api', () => ({
  createSignMessage: vi.fn().mockReturnValue('sign-msg'),
  createAuthToken: vi.fn().mockReturnValue('auth-token'),
  createLeaseDataSignMessage: vi.fn().mockReturnValue('lease-data-sign-msg'),
  getLeaseConnectionInfo: vi.fn(),
}));

vi.mock('../../api/fred', () => ({
  pollLeaseUntilReady: vi.fn(),
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  cosmosTx: vi.fn(),
}));

vi.mock('../../utils/errors', () => ({
  logError: vi.fn(),
}));

vi.mock('./utils', () => ({
  extractLeaseUuidFromTxResult: vi.fn().mockReturnValue('new-lease-uuid'),
  uploadPayloadToProvider: vi.fn().mockResolvedValue({ success: true, data: { message: 'ok' } }),
  computePayloadHash: vi.fn(),
}));

vi.mock('./transactions', () => ({
  resolveSkuItems: vi.fn(),
}));

vi.mock('../../registry/appRegistry', () => ({
  validateAppName: vi.fn().mockReturnValue(null),
}));

import { getCreditEstimate, getLease } from '../../api/billing';
import { getProviders, getSKUs } from '../../api/sku';
import { getLeaseConnectionInfo } from '../../api/provider-api';
import { pollLeaseUntilReady, getLeaseLogs, getLeaseProvision } from '../../api/fred';
import { cosmosTx } from '@manifest-network/manifest-mcp-browser';
import { uploadPayloadToProvider } from './utils';
import { resolveSkuItems } from './transactions';

const ADDRESS = 'manifest1abc';
const CLIENT_MANAGER = {} as CosmosClientManager;

function makeRegistry(apps: AppEntry[] = []): AppRegistryAccess {
  const store = [...apps];
  return {
    getApps: () => [...store],
    getApp: (_addr: string, name: string) => store.find((a) => a.name === name) ?? null,
    getAppByLease: (_addr: string, uuid: string) => store.find((a) => a.leaseUuid === uuid) ?? null,
    addApp: vi.fn((_addr: string, entry: AppEntry) => { store.push(entry); return entry; }),
    updateApp: vi.fn((_addr: string, uuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>) => {
      const idx = store.findIndex((a) => a.leaseUuid === uuid);
      if (idx === -1) return null;
      store[idx] = { ...store[idx], ...updates };
      return store[idx];
    }),
  };
}

function makeOptions(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return {
    clientManager: CLIENT_MANAGER,
    address: ADDRESS,
    appRegistry: makeRegistry(),
    signArbitrary: vi.fn().mockResolvedValue({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pubkey' },
      signature: 'sig',
    }),
    ...overrides,
  };
}

function makePayload(): PayloadAttachment {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    filename: 'docker-compose.yml',
    size: 3,
    hash: 'a'.repeat(64),
  };
}

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: '660e8400-e29b-41d4-a716-446655440000',
    providerUrl: 'https://fred.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

describe('deriveAppName', () => {
  it('strips extension and lowercases', () => {
    expect(deriveAppName('MyApp.yml')).toBe('myapp');
  });

  it('replaces invalid chars with hyphens', () => {
    expect(deriveAppName('my_app v2.yaml')).toBe('my-app-v2');
  });

  it('collapses consecutive hyphens', () => {
    expect(deriveAppName('my___app.yml')).toBe('my-app');
  });

  it('trims leading/trailing hyphens', () => {
    expect(deriveAppName('-my-app-.yml')).toBe('my-app');
  });

  it('truncates to 32 chars', () => {
    const long = 'a'.repeat(50) + '.yml';
    expect(deriveAppName(long).length).toBeLessThanOrEqual(32);
  });

  it('returns "app" for empty result', () => {
    expect(deriveAppName('...yml')).toBe('app');
  });
});

describe('executeDeployApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without payload', async () => {
    const result = await executeDeployApp({}, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No file attached');
  });

  it('returns error without wallet', async () => {
    const result = await executeDeployApp({}, makeOptions({ address: undefined }), makePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error for invalid size tier', async () => {
    const result = await executeDeployApp({ size: 'xxlarge' }, makeOptions(), makePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid size');
    expect(result.error).toContain('micro, small, medium, large');
  });

  it('accepts all valid size tiers', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    for (const tier of ['micro', 'small', 'medium', 'large']) {
      const result = await executeDeployApp({ size: tier }, makeOptions(), makePayload());
      // Should not fail with size validation error
      if (result.error) {
        expect(result.error).not.toContain('Invalid size');
      }
    }
  });

  it('returns confirmation with valid input', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-small', providerUuid: 'p1', price: { denom: 'umfx', amount: '1000000' } } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', name: 'Provider', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);

    const result = await executeDeployApp({}, makeOptions(), makePayload());
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('docker-compose');
  });
});

describe('executeConfirmedDeployApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates lease, uploads, and polls to ready using connection endpoint for URL', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(pollLeaseUntilReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: 'https://app.example.com',
        ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 12345 } },
      },
    });

    const onProgress = vi.fn();
    const registry = makeRegistry();
    const options = makeOptions({ appRegistry: registry, onProgress });

    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      options,
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBe('https://app.example.com');
    expect((result.data as any).connection.ports['80/tcp'].host_port).toBe(12345);
    expect(onProgress).toHaveBeenCalled();
    expect(registry.addApp).toHaveBeenCalled();
    expect(getLeaseConnectionInfo).toHaveBeenCalled();
  });

  it('handles lease creation failure', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 1, rawLog: 'insufficient funds' } as any);

    const onProgress = vi.fn();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ onProgress }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient funds');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }));
  });

  it('handles upload failure', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: false, error: 'upload error' });

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('upload failed');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', { status: 'failed' });
  });

  it('includes logs and provision last_error in failure message', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(pollLeaseUntilReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      error: 'container crashed',
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 3,
      last_error: 'OOMKilled',
    });
    vi.mocked(getLeaseLogs).mockResolvedValue({
      lease_uuid: 'lease-1',
      tenant: 'manifest1test',
      provider_uuid: 'p1',
      logs: { '0': 'Error: out of memory' },
    });

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('container crashed');
    expect(result.error).toContain('OOMKilled');
    expect(result.error).toContain('out of memory');
  });

  it('still reports failure when log/provision fetch fails', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(pollLeaseUntilReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_REJECTED,
      error: 'rejected by provider',
    });
    vi.mocked(getLeaseProvision).mockRejectedValue(new Error('network error'));
    vi.mocked(getLeaseLogs).mockRejectedValue(new Error('network error'));

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('rejected by provider');
  });

  it('falls back to chain state when polling throws', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(pollLeaseUntilReady).mockRejectedValue(new Error('polling timeout'));

    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    // Should fall back to chain state which says ACTIVE
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
  });

  it('succeeds without URL when connection endpoint fails', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(pollLeaseUntilReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('404 not found'));

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBeUndefined();
  });
});

describe('executeStopApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for nonexistent app', async () => {
    const result = await executeStopApp({ app_name: 'ghost' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No app found');
  });

  it('returns error for already stopped app', async () => {
    const app = makeApp({ status: 'stopped' });
    const result = await executeStopApp({ app_name: 'my-app' }, makeOptions({ appRegistry: makeRegistry([app]) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('already stopped');
  });

  it('returns confirmation for running app', async () => {
    const app = makeApp();
    const result = await executeStopApp({ app_name: 'my-app' }, makeOptions({ appRegistry: makeRegistry([app]) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });
});

describe('executeConfirmedStopApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes lease and updates registry', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedStopApp(
      { app_name: 'my-app', leaseUuid: app.leaseUuid },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('stopped');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { status: 'stopped' });
  });
});

describe('executeFundCredits', () => {
  it('returns error for invalid amount', () => {
    const result = executeFundCredits({ amount: -5 }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive');
  });

  it('returns confirmation with correct micro amount', () => {
    const result = executeFundCredits({ amount: 50 }, makeOptions());
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args.microAmount).toBe(50_000_000);
  });
});

describe('executeConfirmedFundCredits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('funds credits successfully', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);

    const result = await executeConfirmedFundCredits(
      { amount: 50, denomString: '50000000upwr', address: ADDRESS },
      CLIENT_MANAGER
    );

    expect(result.success).toBe(true);
    expect((result.data as any).amount).toBe(50);
  });
});

describe('executeCosmosTransaction', () => {
  it('returns error without module', () => {
    const result = executeCosmosTransaction({ subcommand: 'x', args: '[]' }, makeOptions());
    expect(result.success).toBe(false);
  });

  it('returns confirmation', () => {
    const result = executeCosmosTransaction(
      { module: 'bank', subcommand: 'send', args: '["addr", "100umfx"]' },
      makeOptions()
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });
});

describe('executeConfirmedCosmosTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes transaction', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);

    const result = await executeConfirmedCosmosTx(
      { module: 'bank', subcommand: 'send', parsedArgs: ['addr', '100umfx'] },
      CLIENT_MANAGER
    );

    expect(result.success).toBe(true);
    expect(cosmosTx).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'send', ['addr', '100umfx'], true);
  });
});
