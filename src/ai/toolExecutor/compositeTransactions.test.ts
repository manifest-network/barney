import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveAppName,
  formatConnectionUrl,
  extractUrlFromFredStatus,
  extractPrimaryServicePorts,
  formatLeaseItems,
  parseAndValidateStackServices,
  executeDeployApp,
  executeConfirmedDeployApp,
  executeStopApp,
  executeConfirmedStopApp,
  executeFundCredits,
  executeConfirmedFundCredits,
  executeCosmosTransaction,
  executeConfirmedCosmosTx,
  executeBatchDeploy,
  executeConfirmedBatchDeploy,
  executeRestartApp,
  executeConfirmedRestartApp,
  executeUpdateApp,
  executeConfirmedUpdateApp,
  type BatchDeployEntry,
} from './compositeTransactions';
import type { ToolExecutorOptions, AppRegistryAccess, PayloadAttachment } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-browser';
import type { AppEntry } from '../../registry/appRegistry';
import { LeaseState } from '../../api/billing';
import { ProviderApiError } from '../../api/provider-api';

// Mock external modules
vi.mock('../../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/billing')>();
  return {
    ...actual,
    getCreditEstimate: vi.fn(),
    getCreditAccount: vi.fn(),
    getLease: vi.fn(),
  };
});

vi.mock('../../api/sku', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sku')>();
  return {
    ...actual,
    getProviders: vi.fn(),
    getSKUs: vi.fn(),
  };
});

vi.mock('../../api/provider-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/provider-api')>();
  return {
    ...actual,
    createSignMessage: vi.fn().mockReturnValue('sign-msg'),
    createAuthToken: vi.fn().mockReturnValue('auth-token'),
    createLeaseDataSignMessage: vi.fn().mockReturnValue('lease-data-sign-msg'),
    getLeaseConnectionInfo: vi.fn(),
  };
});

vi.mock('../../api/fred', () => ({
  waitForLeaseReady: vi.fn(),
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
  restartLease: vi.fn(),
  updateLease: vi.fn(),
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

vi.mock('../../registry/appRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry/appRegistry')>();
  return {
    ...actual,
    validateAppName: vi.fn().mockReturnValue(null),
  };
});

import { getCreditEstimate, getLease, getCreditAccount } from '../../api/billing';
import { getProviders, getSKUs } from '../../api/sku';
import { getLeaseConnectionInfo } from '../../api/provider-api';
import { waitForLeaseReady, getLeaseLogs, getLeaseProvision, restartLease, updateLease } from '../../api/fred';
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
    findApp: (_addr: string, name: string) => {
      const lower = name.toLowerCase();
      return store.find((a) => a.name.endsWith(`-${lower}`)) ?? store.find((a) => a.name.includes(lower)) ?? null;
    },
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

describe('extractUrlFromFredStatus', () => {
  it('returns first endpoint URL', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '8080/tcp': 'http://1.2.3.4:32456' },
    })).toBe('http://1.2.3.4:32456');
  });

  it('returns undefined when no endpoints', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
    })).toBeUndefined();
  });

  it('returns undefined for empty endpoints', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: {},
    })).toBeUndefined();
  });

  it('extracts URL from instances ports + host', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      instances: [{ name: 'web', status: 'running', ports: { '8080/tcp': 32456 } }],
    }, '1.2.3.4')).toBe('1.2.3.4:32456');
  });

  it('prefers endpoints over instances', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '8080/tcp': 'http://1.2.3.4:11111' },
      instances: [{ name: 'web', status: 'running', ports: { '8080/tcp': 22222 } }],
    }, '1.2.3.4')).toBe('http://1.2.3.4:11111');
  });

  it('extracts URL from stack services using primary service priority', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      services: {
        db: { instances: [{ name: 'db-0', status: 'running', ports: { '5432/tcp': 32100 } }] },
        web: { instances: [{ name: 'web-0', status: 'running', ports: { '80/tcp': 32200 } }] },
      },
    }, '1.2.3.4')).toBe('1.2.3.4:32200');
  });

  it('falls back to non-backend service in stack when no primary name', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      services: {
        db: { instances: [{ name: 'db-0', status: 'running', ports: { '5432/tcp': 32100 } }] },
        api: { instances: [{ name: 'api-0', status: 'running', ports: { '3000/tcp': 32300 } }] },
      },
    }, '1.2.3.4')).toBe('1.2.3.4:32300');
  });
});

describe('extractPrimaryServicePorts', () => {
  it('returns undefined for empty services', () => {
    expect(extractPrimaryServicePorts({})).toBeUndefined();
  });

  it('prefers service named "web"', () => {
    const result = extractPrimaryServicePorts({
      db: { instances: [{ ports: { '5432/tcp': 32100 } }] },
      web: { instances: [{ ports: { '80/tcp': 32200 } }] },
    });
    expect(result).toEqual({ serviceName: 'web', ports: { '80/tcp': 32200 } });
  });

  it('prefers service named "app"', () => {
    const result = extractPrimaryServicePorts({
      redis: { instances: [{ ports: { '6379/tcp': 32300 } }] },
      app: { instances: [{ ports: { '3000/tcp': 32400 } }] },
    });
    expect(result).toEqual({ serviceName: 'app', ports: { '3000/tcp': 32400 } });
  });

  it('prefers non-backend service over backend', () => {
    const result = extractPrimaryServicePorts({
      postgres: { instances: [{ ports: { '5432/tcp': 32100 } }] },
      api: { instances: [{ ports: { '8080/tcp': 32200 } }] },
    });
    expect(result).toEqual({ serviceName: 'api', ports: { '8080/tcp': 32200 } });
  });

  it('falls back to backend service if no other option', () => {
    const result = extractPrimaryServicePorts({
      db: { instances: [{ ports: { '5432/tcp': 32100 } }] },
    });
    expect(result).toEqual({ serviceName: 'db', ports: { '5432/tcp': 32100 } });
  });

  it('handles top-level service ports', () => {
    const result = extractPrimaryServicePorts({
      web: { ports: { '80/tcp': 32200 } },
    });
    expect(result).toEqual({ serviceName: 'web', ports: { '80/tcp': 32200 } });
  });

  it('skips services with empty ports', () => {
    const result = extractPrimaryServicePorts({
      web: { ports: {} },
      api: { instances: [{ ports: { '3000/tcp': 32300 } }] },
    });
    expect(result).toEqual({ serviceName: 'api', ports: { '3000/tcp': 32300 } });
  });
});

describe('formatConnectionUrl', () => {
  it('adds https for non-local hosts', () => {
    expect(formatConnectionUrl('example.com')).toBe('https://example.com');
  });

  it('adds http for localhost', () => {
    expect(formatConnectionUrl('localhost:8080')).toBe('http://localhost:8080');
  });

  it('adds http for 127.0.0.1', () => {
    expect(formatConnectionUrl('127.0.0.1:12345')).toBe('http://127.0.0.1:12345');
  });

  it('preserves existing protocol', () => {
    expect(formatConnectionUrl('https://example.com:443')).toBe('https://example.com:443');
  });

  it('extracts port from connection.ports with host', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      ports: { '8080/tcp': { host_ip: '1.2.3.4', host_port: 32456 } },
    })).toBe('https://1.2.3.4:32456');
  });

  it('prefers connection.host over host_ip', () => {
    expect(formatConnectionUrl('fallback', {
      host: 'https://my-app.example.com',
      ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 12345 } },
    })).toBe('https://my-app.example.com:12345');
  });

  it('omits port for standard 80/443', () => {
    expect(formatConnectionUrl('example.com', {
      host: 'example.com',
      ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 443 } },
    })).toBe('https://example.com');
  });

  it('returns undefined when no host', () => {
    expect(formatConnectionUrl(undefined)).toBeUndefined();
  });

  it('handles Docker PascalCase port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': { HostIp: '0.0.0.0', HostPort: '32456' } },
    })).toBe('http://127.0.0.1:32456');
  });

  it('handles Docker array port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '32789' }] },
    })).toBe('http://127.0.0.1:32789');
  });

  it('handles plain number port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': 12345 },
    })).toBe('http://127.0.0.1:12345');
  });
});

describe('formatLeaseItems', () => {
  it('returns single item without service names', () => {
    expect(formatLeaseItems('sku-123')).toEqual(['sku-123:1']);
  });

  it('returns single item for empty array', () => {
    expect(formatLeaseItems('sku-123', [])).toEqual(['sku-123:1']);
  });

  it('returns items with service name suffixes', () => {
    expect(formatLeaseItems('sku-123', ['web', 'db'])).toEqual([
      'sku-123:1:web',
      'sku-123:1:db',
    ]);
  });

  it('handles single service name', () => {
    expect(formatLeaseItems('sku-123', ['web'])).toEqual(['sku-123:1:web']);
  });

  it('throws on non-string service name', () => {
    expect(() => formatLeaseItems('sku-123', [123 as unknown as string])).toThrow('Invalid service name');
  });

  it('throws on empty string service name', () => {
    expect(() => formatLeaseItems('sku-123', [''])).toThrow('Invalid service name');
  });
});

describe('parseAndValidateStackServices', () => {
  it('parses valid services JSON', () => {
    const json = JSON.stringify({ web: { image: 'nginx', port: '80' }, db: { image: 'postgres' } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.serviceNames).toEqual(['web', 'db']);
      expect(result.services.web.image).toBe('nginx');
      expect(result.services.db.image).toBe('postgres');
    }
  });

  it('returns error for invalid JSON', () => {
    const result = parseAndValidateStackServices('not-json', false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Invalid services JSON');
  });

  it('returns error for empty services', () => {
    const result = parseAndValidateStackServices('{}', false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('at least one service');
  });

  it('returns error for invalid service name', () => {
    const json = JSON.stringify({ 'Bad Name': { image: 'nginx' } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Invalid service name');
  });

  it('returns error for missing image', () => {
    const json = JSON.stringify({ web: { port: '80' } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('requires an "image"');
  });

  it('returns error for non-string env value', () => {
    const json = JSON.stringify({ web: { image: 'nginx', env: { PORT: 80 } } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('must have a string value');
  });

  it('applies env defaults when applyEnvDefaults is true', () => {
    const json = JSON.stringify({ db: { image: 'postgres' } });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.env).toBeDefined();
      expect(result.services.db.env!.POSTGRES_PASSWORD).toBeDefined();
    }
  });

  it('skips env defaults when applyEnvDefaults is false', () => {
    const json = JSON.stringify({ db: { image: 'postgres' } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.env).toBeUndefined();
    }
  });

  it('sets needsStorage when known image requires storage', () => {
    const json = JSON.stringify({ db: { image: 'postgres' } });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.needsStorage).toBe(true);
    }
  });

  it('extracts health_check from service config', () => {
    const json = JSON.stringify({
      web: { image: 'nginx', health_check: { test: ['CMD-SHELL', 'curl -f http://localhost'], interval: '30s' } },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.health_check).toEqual({
        test: ['CMD-SHELL', 'curl -f http://localhost'],
        interval: '30s',
      });
    }
  });

  it('applies known image health_check defaults', () => {
    const json = JSON.stringify({ db: { image: 'postgres' } });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.health_check).toBeDefined();
      expect(result.services.db.health_check!.test[0]).toBe('CMD-SHELL');
    }
  });

  it('user-provided health_check overrides known image default', () => {
    const customHealthCheck = {
      test: ['CMD-SHELL', 'curl -f http://localhost:5432/health'],
      interval: '30s',
      timeout: '10s',
      retries: 2,
    };
    const json = JSON.stringify({ db: { image: 'postgres', health_check: customHealthCheck } });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.health_check).toEqual(customHealthCheck);
      expect(result.services.db.health_check!.test[1]).toBe('curl -f http://localhost:5432/health');
    }
  });

  it('returns error for invalid health_check.test', () => {
    const json = JSON.stringify({
      web: { image: 'nginx', health_check: { test: 'not-an-array' } },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('health_check.test must be an array');
  });

  it('extracts stop_grace_period, init, expose, labels from service config', () => {
    const json = JSON.stringify({
      web: {
        image: 'nginx',
        stop_grace_period: '30s',
        init: true,
        expose: '3000,9090',
        labels: { app: 'myapp' },
      },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.stop_grace_period).toBe('30s');
      expect(result.services.web.init).toBe(true);
      expect(result.services.web.expose).toBe('3000,9090');
      expect(result.services.web.labels).toEqual({ app: 'myapp' });
    }
  });

  it('applies known stack depends_on defaults for matching stacks', () => {
    const json = JSON.stringify({
      web: { image: 'wordpress', port: '80' },
      db: { image: 'mysql', port: '3306' },
    });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } });
    }
  });

  it('preserves custom depends_on from user input', () => {
    const json = JSON.stringify({
      web: {
        image: 'nginx',
        port: '80',
        depends_on: { api: { condition: 'service_started' } },
      },
      api: { image: 'node:20', port: '3000' },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.depends_on).toEqual({ api: { condition: 'service_started' } });
    }
  });

  it('applies known stack depends_on even when applyEnvDefaults is false', () => {
    const json = JSON.stringify({
      web: { image: 'wordpress', port: '80' },
      db: { image: 'mysql', port: '3306' },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // depends_on injection is independent of applyEnvDefaults
      expect(result.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } });
      // but env defaults should NOT be applied
      expect(result.services.db.env).toBeUndefined();
    }
  });

  it('does not apply known stack depends_on for non-matching stacks', () => {
    const json = JSON.stringify({
      web: { image: 'nginx', port: '80' },
      db: { image: 'postgres', port: '5432' },
      cache: { image: 'redis', port: '6379' },
    });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // 3-service stack should not match any known 2-service stack
      expect(result.services.web.depends_on).toBeUndefined();
    }
  });

  it('does not apply known image port defaults to backend service names', () => {
    const backendNames = ['db', 'database', 'postgres', 'mysql', 'redis', 'mongo'];
    for (const name of backendNames) {
      const json = JSON.stringify({ [name]: { image: 'mysql:9' } });
      const result = parseAndValidateStackServices(json, true, 'test');
      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.services[name].port).toBeUndefined();
      }
    }
  });

  it('respects explicitly provided port on backend services', () => {
    const json = JSON.stringify({ db: { image: 'mysql:9', port: '3306' } });
    const result = parseAndValidateStackServices(json, true, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.port).toBe('3306');
    }
  });
});

describe('executeDeployApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without payload and without image', async () => {
    const result = await executeDeployApp({}, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No file attached and no image specified');
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
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1', price: { denom: 'umfx', amount: '1000000' } } as any,
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

  it('builds manifest from image when no payload', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'redis:8.4', port: '6379' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('redis');
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    expect(result.pendingAction?.args.app_name).toBe('redis');
  });

  it('derives app name from image when app_name not specified', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'docker.io/library/postgres:18', port: '5432' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.pendingAction?.args.app_name).toBe('postgres');
  });

  it('returns error for invalid env JSON', async () => {
    const result = await executeDeployApp(
      { image: 'redis:8.4', env: 'not-json' },
      makeOptions()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid env JSON');
  });

  it('rejects blocked env variable names', async () => {
    const blockedVars = [
      'LD_PRELOAD', 'PATH', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND',
      'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
      'DOCKER_HOST', 'SHELLOPTS', 'BASHOPTS', 'CDPATH',
    ];
    for (const name of blockedVars) {
      const result = await executeDeployApp(
        { image: 'redis:8.4', env: JSON.stringify({ [name]: 'value' }) },
        makeOptions()
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked env variable');
      expect(result.error).toContain(name);
    }
  });

  it('allows non-blocked env variable names', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'redis:8.4', env: '{"REDIS_PASSWORD":"secret","MY_VAR":"hello"}' },
      makeOptions()
    );
    // Should not fail with blocked env error
    if (!result.success) {
      expect(result.error).not.toContain('Blocked env variable');
    }
  });

  it('upgrades to storage SKU when storage=true and size is micro', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-small', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'postgres:latest', port: '5432', storage: true },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('upgraded for storage');
    expect(result.confirmationMessage).toContain('small');
    expect(resolveSkuItems).toHaveBeenCalledWith(
      [{ sku_name: 'docker-small', quantity: 1 }],
      expect.anything()
    );
    // Size stored in pendingAction should reflect the upgrade
    expect(result.pendingAction?.args.size).toBe('small');
  });

  it('does not upgrade when storage=true and size is already small', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-small', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'postgres:latest', port: '5432', storage: true, size: 'small' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.confirmationMessage).not.toContain('upgraded for storage');
  });

  it('does not upgrade when storage is not set', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'nginx:latest', port: '80' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.confirmationMessage).not.toContain('upgraded for storage');
    expect(resolveSkuItems).toHaveBeenCalledWith(
      [{ sku_name: 'docker-micro', quantity: 1 }],
      expect.anything()
    );
  });

  it('applies known image defaults when model omits args', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-small', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    // Deploy neo4j with NO args except image — defaults should fill in
    const result = await executeDeployApp(
      { image: 'neo4j:5' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    // Should have known defaults filled in
    expect(manifest.ports).toEqual({ '7474/tcp': {}, '7687/tcp': {} });
    // NEO4J_AUTH should be neo4j/<generated password>
    expect(manifest.env.NEO4J_AUTH).toMatch(/^neo4j\/[A-Za-z0-9]{16}$/);
    // Storage upgrade should be triggered
    expect(result.confirmationMessage).toContain('upgraded for storage');
  });

  it('model-provided values override known image defaults', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    // Model provides custom port and env — should override known defaults
    const result = await executeDeployApp(
      { image: 'postgres:16', port: '5433', env: '{"POSTGRES_PASSWORD":"custom-pass"}' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    // Model's port wins
    expect(manifest.ports).toEqual({ '5433/tcp': {} });
    // Model's env wins
    expect(manifest.env.POSTGRES_PASSWORD).toBe('custom-pass');
    // Known user/tmpfs still applied (model didn't provide them)
    expect(manifest.user).toBe('999:999');
    expect(manifest.tmpfs).toEqual(['/var/run/postgresql']);
  });

  it('does not apply defaults for unknown images', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'my-custom-image:v3', port: '3000' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.ports).toEqual({ '3000/tcp': {} });
    expect(manifest.env).toBeUndefined();
    expect(manifest.user).toBeUndefined();
  });

  it('prefers file attachment over image when both present', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'redis:8.4' },
      makeOptions(),
      makePayload()  // file takes precedence
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    // Should use filename-derived name, not image-derived
    expect(result.confirmationMessage).toContain('docker-compose');
    expect(result.pendingAction?.args._generatedManifest).toBeUndefined();
  });

  it('returns confirmation for stack deploy with services param', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const services = JSON.stringify({
      web: { image: 'nginx', port: '80' },
      db: { image: 'postgres', port: '5432', env: { POSTGRES_PASSWORD: '' } },
    });
    const result = await executeDeployApp(
      { app_name: 'my-stack', services },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    expect(result.pendingAction?.args._serviceNames).toEqual(['web', 'db']);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.services).toBeDefined();
    expect(manifest.services.web.image).toBe('nginx');
    expect(manifest.services.db.image).toBe('postgres');
  });

  it('returns error for invalid services JSON', async () => {
    const result = await executeDeployApp(
      { app_name: 'bad-stack', services: 'not-json' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid services JSON');
  });

  it('returns error for invalid service name in stack', async () => {
    const services = JSON.stringify({
      'Invalid Name': { image: 'nginx' },
    });
    const result = await executeDeployApp(
      { app_name: 'bad-stack', services },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid service name');
  });

  it('returns error when both services and image are provided', async () => {
    const services = JSON.stringify({
      web: { image: 'nginx', port: '80' },
    });
    const result = await executeDeployApp(
      { app_name: 'my-stack', services, image: 'redis' },
      makeOptions()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('mutually exclusive');
  });

  it('uses shared password for all auto-generated env vars in stack', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const services = JSON.stringify({
      web: { image: 'wordpress', env: { WORDPRESS_DB_PASSWORD: '' } },
      db: { image: 'postgres', env: { POSTGRES_PASSWORD: '' } },
    });
    const result = await executeDeployApp(
      { app_name: 'stack-wp', services },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    // Both passwords should be the same (shared password)
    expect(manifest.services.web.env.WORDPRESS_DB_PASSWORD).toBeDefined();
    expect(manifest.services.web.env.WORDPRESS_DB_PASSWORD).toBe(manifest.services.db.env.POSTGRES_PASSWORD);
    // And not empty
    expect(manifest.services.web.env.WORDPRESS_DB_PASSWORD.length).toBeGreaterThan(0);
  });

  it('rejects non-string env values in stack deploy', async () => {
    const services = JSON.stringify({
      web: { image: 'nginx', env: { PORT: 80 } },
    });
    const result = await executeDeployApp(
      { app_name: 'bad-stack', services },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must have a string value');
  });

  it('rejects non-string env values in single-service deploy', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', env: '{"PORT": 80}' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must have a string value');
  });

  it('parses health_check JSON and includes it in generated manifest', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      {
        image: 'nginx',
        port: '80',
        health_check: '{"test":["CMD-SHELL","curl -f http://localhost"],"interval":"30s","timeout":"5s","retries":3}',
      },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction?.args._generatedManifest as string);
    expect(manifest.health_check.test).toEqual(['CMD-SHELL', 'curl -f http://localhost']);
    expect(manifest.health_check.interval).toBe('30s');
  });

  it('returns error for invalid health_check JSON', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', health_check: 'not-json' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid health_check JSON');
  });

  it('returns error for health_check with invalid test field', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', health_check: '{"test":"not-an-array"}' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('health_check.test must be an array');
  });

  it('passes stop_grace_period, init, expose, labels through to manifest', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      {
        image: 'nginx',
        port: '80',
        stop_grace_period: '30s',
        init: true,
        expose: '3000,9090',
        labels: '{"app":"myapp"}',
      },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction?.args._generatedManifest as string);
    expect(manifest.stop_grace_period).toBe('30s');
    expect(manifest.init).toBe(true);
    expect(manifest.expose).toEqual(['3000', '9090']);
    expect(manifest.labels).toEqual({ app: 'myapp' });
  });

  it('returns error for invalid labels JSON', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', labels: 'not-json' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid labels JSON');
  });

  it('applies known image health_check default for postgres deploy', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-small', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'postgres:18' },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction?.args._generatedManifest as string);
    expect(manifest.health_check).toBeDefined();
    expect(manifest.health_check.test[0]).toBe('CMD-SHELL');
    expect(manifest.health_check.test[1]).toContain('pg_isready');
  });

  it('user-provided health_check overrides known image default for deploy', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-small', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const customHealthCheck = {
      test: ['CMD-SHELL', 'pg_isready -U custom_user -d custom_db'],
      interval: '20s',
      timeout: '10s',
      retries: 10,
    };

    const result = await executeDeployApp(
      { image: 'postgres:18', health_check: JSON.stringify(customHealthCheck) },
      makeOptions()
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction?.args._generatedManifest as string);
    expect(manifest.health_check).toEqual(customHealthCheck);
    expect(manifest.health_check.test[1]).toBe('pg_isready -U custom_user -d custom_db');
    expect(manifest.health_check.retries).toBe(10);
  });
});

describe('executeConfirmedDeployApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates lease, uploads, and polls to ready — extracts port from instances', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        instances: [{ instance_index: 0, container_id: 'abc', image: 'test', status: 'running', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } }],
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
    expect((result.data as any).url).toBe('http://127.0.0.1:32456');
    expect(onProgress).toHaveBeenCalled();
    expect(registry.addApp).toHaveBeenCalled();
    expect(getLeaseConnectionInfo).toHaveBeenCalled();

    // Verify waitForLeaseReady receives getAuthToken callback for token refresh
    const pollCall = vi.mocked(waitForLeaseReady).mock.calls[0];
    expect(pollCall[3]).toHaveProperty('getAuthToken');
    expect(typeof pollCall[3]!.getAuthToken).toBe('function');
  });

  it('creates lease, uploads, and polls to ready — extracts port from top-level ports', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
      },
    });

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).url).toBe('http://127.0.0.1:32456');
  });

  it('falls back to fred status when connection endpoint fails', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '80/tcp': 'http://1.2.3.4:32456' },
    });
    vi.mocked(getLeaseConnectionInfo).mockRejectedValue(new Error('connection endpoint failed'));

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).url).toBe('http://1.2.3.4:32456');
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
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      last_error: 'container crashed',
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
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_REJECTED,
      last_error: 'rejected by provider',
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
    vi.mocked(waitForLeaseReady).mockRejectedValue(new Error('polling timeout'));

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

  it('calls onProgress with failed phase when provisioning times out and chain is not active', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    // waitForLeaseReady returns PENDING (non-terminal) — simulates timeout exhaustion
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_PENDING,
    });
    // Chain state is also not ACTIVE
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_PENDING } as any);

    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('deploying');
    expect((result.data as any).message).toContain('still deploying');
    // Verify onProgress was called with failed phase to clear ProgressCard
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'failed', detail: expect.stringContaining('timed out') })
    );
  });

  it('succeeds without URL when connection endpoint fails and fred has no endpoints', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
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

  it('reconstructs payload from _generatedManifest when no payload provided', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        ports: { '6379/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
      },
    });

    const registry = makeRegistry();
    const manifestJson = JSON.stringify({ image: 'redis:8.4', ports: { '6379/tcp': {} } }, null, 2);
    const result = await executeConfirmedDeployApp(
      {
        app_name: 'redis',
        size: 'micro',
        skuUuid: 'sku-1',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        _generatedManifest: manifestJson,
      },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
      // No payload argument
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    // Verify the manifest was uploaded
    expect(uploadPayloadToProvider).toHaveBeenCalled();
    const uploadCall = vi.mocked(uploadPayloadToProvider).mock.calls[0];
    // The hash should be consistent
    expect(uploadCall[2]).toHaveLength(64);
  });

  it('resolves URL from services-only connection response (stack deploy)', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '1.2.3.4',
        services: {
          db: { instances: [{ instance_index: 0, container_id: 'db1', image: 'postgres', status: 'running', ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32100 } } }] },
          web: { instances: [{ instance_index: 0, container_id: 'web1', image: 'nginx', status: 'running', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32200 } } }] },
        },
      },
    });

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      { name: 'my-stack', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).url).toBe('https://1.2.3.4:32200');
    expect((result.data as any).status).toBe('running');
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

// ============================================================================
// Batch deploy tests
// ============================================================================

function makeBatchEntry(name: string): BatchDeployEntry {
  return {
    app_name: name,
    payload: {
      bytes: new Uint8Array([1, 2, 3]),
      filename: `manifest-${name}.json`,
      size: 3,
      hash: 'a'.repeat(64),
    },
  };
}

describe('executeBatchDeploy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeBatchDeploy([makeBatchEntry('app1')], makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error for empty entries', async () => {
    const result = await executeBatchDeploy([], makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No apps to deploy');
  });

  it('returns error for invalid size', async () => {
    const result = await executeBatchDeploy([makeBatchEntry('app1')], makeOptions(), 'xxlarge');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid size');
  });

  it('returns confirmation for valid batch', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2')];
    const result = await executeBatchDeploy(entries, makeOptions());

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.confirmationMessage).toContain('app1');
    expect(result.confirmationMessage).toContain('app2');
    expect(result.pendingAction?.toolName).toBe('batch_deploy');
    expect(result.pendingAction?.args.entries).toHaveLength(2);
  });

  it('returns insufficient credits error when total cost exceeds balance', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1', basePrice: { denom: 'upwr', amount: '1000000' }, unit: 1 } as any,
    ]);
    vi.mocked(resolveSkuItems).mockReturnValue({ items: [{ sku_uuid: 'sku-1', quantity: 1 }] });
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue({
      balances: [{ denom: 'upwr', amount: '500000' }],
    } as any);

    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2'), makeBatchEntry('app3')];
    const result = await executeBatchDeploy(entries, makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
  });
});

describe('executeConfirmedBatchDeploy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for empty entries', async () => {
    const result = await executeConfirmedBatchDeploy({ entries: [] }, CLIENT_MANAGER, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No entries');
  });

  it('deploys all apps in parallel and reports results', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: { host: '127.0.0.1', instances: [{ instance_index: 0, container_id: 'abc', image: 'test', status: 'running', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } }] },
    });

    const onProgress = vi.fn();
    const registry = makeRegistry();
    const entries = [
      {
        app_name: 'game1',
        size: 'micro',
        skuUuid: 'sku-1',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        payload: makePayload(),
      },
      {
        app_name: 'game2',
        size: 'micro',
        skuUuid: 'sku-1',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        payload: makePayload(),
      },
    ];

    const result = await executeConfirmedBatchDeploy(
      { entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress })
    );

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.deployed).toHaveLength(2);
    expect(data.deployed.map((d: any) => d.name)).toContain('game1');
    expect(data.deployed.map((d: any) => d.name)).toContain('game2');
    expect(data.failed).toHaveLength(0);
    expect(onProgress).toHaveBeenCalled();
    // Verify batch progress was emitted
    const lastProgressCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
    expect(lastProgressCall.batch).toBeDefined();
  });

  it('handles partial failure gracefully', async () => {
    // First call succeeds, second fails
    vi.mocked(cosmosTx)
      .mockResolvedValueOnce({ code: 0, transactionHash: 'hash1', rawLog: '' } as any)
      .mockResolvedValueOnce({ code: 1, rawLog: 'insufficient funds' } as any);
    vi.mocked(uploadPayloadToProvider).mockResolvedValue({ success: true, data: { message: 'ok' } });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: { host: '127.0.0.1', instances: [{ instance_index: 0, container_id: 'abc', image: 'test', status: 'running', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } }] },
    });

    const registry = makeRegistry();
    const entries = [
      {
        app_name: 'game1',
        size: 'micro',
        skuUuid: 'sku-1',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        payload: makePayload(),
      },
      {
        app_name: 'game2',
        size: 'micro',
        skuUuid: 'sku-1',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        payload: makePayload(),
      },
    ];

    const result = await executeConfirmedBatchDeploy(
      { entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).deployed.map((d: any) => d.name)).toContain('game1');
    expect((result.data as any).failed).toContain('game2');
  });
});

// ============================================================================
// restart_app tests
// ============================================================================

describe('executeRestartApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without wallet', async () => {
    const result = await executeRestartApp({ app_name: 'my-app' }, makeOptions({ address: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('returns error when app not found', async () => {
    const result = await executeRestartApp({ app_name: 'ghost' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No app found');
  });

  it('returns error when app is not running', async () => {
    const app = makeApp({ status: 'stopped' });
    const result = await executeRestartApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not running');
  });

  it('returns error when app has no provider URL', async () => {
    const app = makeApp({ providerUrl: undefined });
    const result = await executeRestartApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no provider URL');
  });

  it('returns confirmation for running app', async () => {
    const app = makeApp();
    const result = await executeRestartApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('Restart');
    expect(result.pendingAction?.toolName).toBe('restart_app');
  });
});

describe('executeConfirmedRestartApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restarts app and polls to ready', async () => {
    vi.mocked(restartLease).mockResolvedValue({ status: 'restarting' });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
      },
    });

    const onProgress = vi.fn();
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(restartLease).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'restarting' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
  });

  it('handles 409 error from restart endpoint', async () => {
    vi.mocked(restartLease).mockRejectedValue(new ProviderApiError(409, 'lease is not running'));

    const onProgress = vi.fn();
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in a restartable state');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }));
  });

  it('handles poll failure (non-active state)', async () => {
    vi.mocked(restartLease).mockResolvedValue({ status: 'restarting' });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      last_error: 'container crashed',
    });

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('container crashed');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { status: 'failed' });
  });
});

// ============================================================================
// update_app tests
// ============================================================================

describe('executeUpdateApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error without payload and without image', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('No file attached and no image specified');
  });

  it('builds manifest from image when no payload', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'redis:8', port: '6379' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('redis:8');
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
  });

  it('prefers file attachment over image in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'redis:8' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      makePayload()
    );
    expect(result.success).toBe(true);
    expect(result.pendingAction?.args._generatedManifest).toBeUndefined();
    expect(result.confirmationMessage).toContain('new manifest');
  });

  it('returns error when app is stopped', async () => {
    const app = makeApp({ status: 'stopped' });
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      makePayload()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be updated');
  });

  it('allows updating running apps', async () => {
    const app = makeApp({ status: 'running' });
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      makePayload()
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.toolName).toBe('update_app');
  });

  it('allows updating failed apps', async () => {
    const app = makeApp({ status: 'failed' });
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      makePayload()
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('merges old env vars into image-based update manifest', async () => {
    const oldManifest = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'secret123', POSTGRES_USER: 'admin' },
      ports: { '5432/tcp': {} },
      user: '999:999',
      tmpfs: ['/var/run/postgresql'],
    });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'postgres:19', port: '5432' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    const merged = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(merged.image).toBe('postgres:19');
    expect(merged.env.POSTGRES_PASSWORD).toBe('secret123');
    expect(merged.env.POSTGRES_USER).toBe('admin');
    expect(merged.user).toBe('999:999');
    expect(merged.tmpfs).toEqual(['/var/run/postgresql']);
  });

  it('merges old env vars into file-based update payload', async () => {
    const oldManifest = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'secret123' },
      user: '999:999',
    });
    const newManifest = JSON.stringify({ image: 'postgres:19' }, null, 2);
    const payload: PayloadAttachment = {
      bytes: new TextEncoder().encode(newManifest),
      filename: 'manifest.json',
      size: newManifest.length,
      hash: 'b'.repeat(64),
    };
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      payload
    );

    expect(result.success).toBe(true);
    // The _generatedManifest should contain the merged result
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    const merged = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(merged.image).toBe('postgres:19');
    expect(merged.env.POSTGRES_PASSWORD).toBe('secret123');
    expect(merged.user).toBe('999:999');
  });

  it('new env vars override old ones during update merge', async () => {
    const oldManifest = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'oldpass', POSTGRES_DB: 'olddb' },
    });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'postgres:19', env: '{"POSTGRES_DB":"newdb"}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const merged = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(merged.env.POSTGRES_PASSWORD).toBe('oldpass');
    expect(merged.env.POSTGRES_DB).toBe('newdb');
  });

  it('preserves YAML payload when merge cannot parse it', async () => {
    const yamlContent = 'image: nginx:latest\nports:\n  80/tcp: {}';
    const yamlBytes = new TextEncoder().encode(yamlContent);
    const payload: PayloadAttachment = {
      bytes: yamlBytes,
      filename: 'manifest.yaml',
      size: yamlBytes.length,
      hash: 'c'.repeat(64),
    };
    const oldManifest = JSON.stringify({ image: 'nginx:1.24', env: { KEY: 'val' } });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      payload
    );

    expect(result.success).toBe(true);
    // _generatedManifest should NOT be set since YAML can't be parsed/merged
    expect(result.pendingAction?.args._generatedManifest).toBeUndefined();
  });

  it('applies known image defaults for port/user/tmpfs in update (not env)', async () => {
    const app = makeApp({ manifest: undefined });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'postgres:19' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    // Port, user, tmpfs defaults are applied
    expect(manifest.ports).toEqual({ '5432/tcp': {} });
    expect(manifest.user).toBe('999:999');
    expect(manifest.tmpfs).toEqual(['/var/run/postgresql']);
    // Env defaults are NOT applied for updates (old manifest merge handles env)
    expect(manifest.env).toBeUndefined();
  });

  it('skips merge when app has no old manifest', async () => {
    const app = makeApp({ manifest: undefined });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'redis:8', port: '6379' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.image).toBe('redis:8');
    expect(manifest.env).toBeUndefined();
  });

  it('returns confirmation for stack update with services param', async () => {
    const app = makeApp();
    const services = JSON.stringify({
      web: { image: 'nginx:2', port: '80' },
      db: { image: 'postgres:19', port: '5432' },
    });
    const result = await executeUpdateApp(
      { app_name: 'my-app', services },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('stack');
    expect(result.confirmationMessage).toContain('2 services');
    expect(result.pendingAction?.args._isStack).toBe(true);
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.services.web.image).toBe('nginx:2');
    expect(manifest.services.db.image).toBe('postgres:19');
  });

  it('returns error for invalid services JSON in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', services: 'not-json' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid services JSON');
  });

  it('returns error when both services and image are provided in update', async () => {
    const app = makeApp();
    const services = JSON.stringify({ web: { image: 'nginx' } });
    const result = await executeUpdateApp(
      { app_name: 'my-app', services, image: 'redis' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('mutually exclusive');
  });

  it('skips env defaults for stack updates (uses applyEnvDefaults=false)', async () => {
    const app = makeApp();
    const services = JSON.stringify({
      db: { image: 'postgres:19' },
    });
    const result = await executeUpdateApp(
      { app_name: 'my-app', services },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    // Env defaults should NOT be applied for updates
    expect(manifest.services.db.env).toBeUndefined();
    // Port defaults should NOT be applied to backend service names (db)
    expect(manifest.services.db.ports).toBeUndefined();
  });

  it('rejects non-string env values in stack services', async () => {
    const app = makeApp();
    const services = JSON.stringify({
      web: { image: 'nginx', env: { PORT: 80 } },
    });
    const result = await executeUpdateApp(
      { app_name: 'my-app', services },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must have a string value');
    expect(result.error).toContain('PORT');
  });

  it('rejects non-string env values in single-service image update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', env: '{"PORT": 80}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('must have a string value');
  });

  it('parses health_check JSON and includes it in update manifest', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      {
        app_name: 'my-app',
        image: 'nginx',
        port: '80',
        health_check: '{"test":["CMD-SHELL","curl -f http://localhost"],"interval":"30s"}',
      },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.health_check.test).toEqual(['CMD-SHELL', 'curl -f http://localhost']);
    expect(manifest.health_check.interval).toBe('30s');
  });

  it('returns error for invalid health_check JSON in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', health_check: 'not-json' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid health_check JSON');
  });

  it('returns error for health_check with invalid test field in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', health_check: '{"test":"not-an-array"}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('health_check.test must be an array');
  });

  it('passes stop_grace_period, init, expose, labels through in update manifest', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      {
        app_name: 'my-app',
        image: 'nginx',
        port: '80',
        stop_grace_period: '30s',
        init: true,
        expose: '3000,9090',
        labels: '{"app":"myapp"}',
      },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.stop_grace_period).toBe('30s');
    expect(manifest.init).toBe(true);
    expect(manifest.expose).toEqual(['3000', '9090']);
    expect(manifest.labels).toEqual({ app: 'myapp' });
  });

  it('returns error for invalid labels JSON in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', labels: 'not-json' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid labels JSON');
  });

  it('merges old health_check into update when new manifest omits it', async () => {
    const oldManifest = JSON.stringify({
      image: 'postgres:18',
      health_check: { test: ['CMD-SHELL', 'pg_isready'], interval: '10s', timeout: '5s' },
    });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'postgres:19', port: '5432' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.health_check).toEqual({
      test: ['CMD-SHELL', 'pg_isready'],
      interval: '10s',
      timeout: '5s',
    });
  });

  it('merges old stop_grace_period, init, labels, depends_on into update', async () => {
    const oldManifest = JSON.stringify({
      image: 'nginx:1.24',
      stop_grace_period: '30s',
      init: true,
      labels: { app: 'myapp', tier: 'basic' },
      depends_on: { db: { condition: 'service_healthy' } },
    });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx:latest', port: '80' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.stop_grace_period).toBe('30s');
    expect(manifest.init).toBe(true);
    expect(manifest.labels).toEqual({ app: 'myapp', tier: 'basic' });
    expect(manifest.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('new labels override old labels during update merge', async () => {
    const oldManifest = JSON.stringify({
      image: 'nginx:1.24',
      labels: { app: 'myapp', tier: 'basic' },
    });
    const app = makeApp({ manifest: oldManifest });
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx:latest', port: '80', labels: '{"tier":"premium","version":"2"}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.labels).toEqual({ app: 'myapp', tier: 'premium', version: '2' });
  });
});

describe('executeConfirmedUpdateApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates app and polls to ready', async () => {
    vi.mocked(updateLease).mockResolvedValue({ status: 'updating' });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
      },
    });

    const onProgress = vi.fn();
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
      makePayload()
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(updateLease).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'updating' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
    // Registry should have updated manifest
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS,
      app.leaseUuid,
      expect.objectContaining({ manifest: expect.any(String) })
    );
  });

  it('handles 409 error from update endpoint', async () => {
    vi.mocked(updateLease).mockRejectedValue(new ProviderApiError(409, 'lease is not running'));

    const onProgress = vi.fn();
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in an updatable state');
  });

  it('handles poll failure (non-active state)', async () => {
    vi.mocked(updateLease).mockResolvedValue({ status: 'updating' });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      last_error: 'container crashed',
    });

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('container crashed');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { status: 'failed' });
  });

  it('returns error without payload', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Payload missing');
  });

  it('reconstructs payload from _generatedManifest when no payload provided', async () => {
    vi.mocked(updateLease).mockResolvedValue({ status: 'updating' });
    vi.mocked(waitForLeaseReady).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid',
      tenant: ADDRESS,
      provider_uuid: 'p1',
      connection: {
        host: '127.0.0.1',
        ports: { '6379/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
      },
    });

    const app = makeApp();
    const registry = makeRegistry([app]);
    const manifestJson = JSON.stringify({ image: 'redis:8', ports: { '6379/tcp': {} } }, null, 2);
    const result = await executeConfirmedUpdateApp(
      {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        providerUrl: app.providerUrl,
        _generatedManifest: manifestJson,
      },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(updateLease).toHaveBeenCalled();
  });
});
