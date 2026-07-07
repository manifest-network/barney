import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatConnectionUrl, extractPrimaryServicePorts, deriveUrlFromConnection } from './helpers';
import {
  deriveAppName,
  extractUrlFromFredStatus,
  extractServiceNamesFromPayload,
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
  buildFredAuthCtx,
  classifyLeaseChainState,
  handleDeployManifestError,
  type BatchDeployEntry,
} from './compositeTransactions';
import type { ToolExecutorOptions, PayloadAttachment } from './types';
import type { CosmosClientManager, DeployResult } from '@manifest-network/manifest-mcp-core';
import type { AppEntry } from '../../registry/appRegistry';
import { makeRegistry } from './testHelpers';
import { LeaseState } from '../../api/billing';
import { ProviderApiError } from '../../api/provider-api';
import { logError } from '../../utils/errors';

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

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => ({
  ...(await importOriginal()),
  cosmosTx: vi.fn(),
  setItemCustomDomain: vi.fn(),
}));

// B4: spread importOriginal so manifest.ts's buildManifest/mergeManifest/metaHashHex
// re-exports survive — a full-replace mock would nuke them and break existing tests.
vi.mock('@manifest-network/manifest-mcp-fred', async (importOriginal) => ({
  ...(await importOriginal()),
  deployManifest: vi.fn(),
  TerminalChainStateError: class TerminalChainStateError extends Error {
    constructor(m: string) { super(m); this.name = 'TerminalChainStateError'; }
  },
}));

vi.mock('../../utils/errors', async (orig) => {
  const actual = await orig<typeof import('../../utils/errors')>();
  return {
    ...actual,
    logError: vi.fn(),
  };
});

vi.mock('./utils', () => ({
  extractLeaseUuidFromTxResult: vi.fn().mockReturnValue('new-lease-uuid'),
  uploadPayloadToProvider: vi.fn().mockResolvedValue({ success: true, data: { message: 'ok' } }),
  computePayloadHash: vi.fn(),
}));

vi.mock('../../registry/appRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry/appRegistry')>();
  return {
    ...actual,
    validateAppName: vi.fn().mockReturnValue(null),
  };
});

// Default: no collision. Tests that exercise the dedupe pre-check
// override with `.mockResolvedValueOnce(...)` or `.mockRejectedValueOnce(...)`.
vi.mock('../../api/leaseByCustomDomain', () => ({
  queryLeaseByCustomDomain: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../api/readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({ query: { __tag: 'read-query-client' } }),
}));

import { getCreditEstimate, getLease, getCreditAccount } from '../../api/billing';
import { getProviders, getSKUs, Unit } from '../../api/sku';
import { DENOMS } from '../../api/config';
import { getLeaseConnectionInfo } from '../../api/provider-api';
import { waitForLeaseReady, getLeaseLogs, getLeaseProvision, restartLease, updateLease } from '../../api/fred';
import { cosmosTx, setItemCustomDomain, ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { TerminalChainStateError, deployManifest } from '@manifest-network/manifest-mcp-fred';
import { uploadPayloadToProvider } from './utils';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';

const ADDRESS = 'manifest1abc';
const CLIENT_MANAGER = {} as CosmosClientManager;

const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'sku-1', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'sku-2', providerUuid: 'p1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-medium', skuUuid: 'sku-3', providerUuid: 'p1', cores: 2, ramMB: 2048, diskGB: 10, pricePerHour: 0.2, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'sku-4', providerUuid: 'p1', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

function makeOptions(overrides: Partial<ToolExecutorOptions> = {}): ToolExecutorOptions {
  return {
    clientManager: CLIENT_MANAGER,
    address: ADDRESS,
    appRegistry: makeRegistry(),
    signing: {
      providerAuth: { providerToken: vi.fn(), leaseDataToken: vi.fn() },
      authTokens: {
        getAuthToken: vi.fn().mockResolvedValue('mock-auth-token'),
        getLeaseDataAuthToken: vi.fn().mockResolvedValue('mock-lease-data-token'),
      },
      withSign: <T,>(fn: () => Promise<T>) => fn(),
    },
    tiers: SAMPLE_TIERS,
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

function makeDeployResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return {
    lease_uuid: 'new-lease-uuid' as DeployResult['lease_uuid'],
    provider_url: 'https://fred.example.com',
    state: LeaseState.LEASE_STATE_ACTIVE,
    connection: {
      host: '127.0.0.1',
      ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
    },
    ...overrides,
  } as DeployResult;
}

// Valid-JSON counterpart to makePayload(), for executeDeployApp plan-phase
// tests that exercise the file-attach path post-§3.9 (non-JSON payloads are
// now rejected before reaching confirmation — see "rejects a non-JSON file
// upload" below).
function makeJsonPayload(filename = 'docker-compose.yml'): PayloadAttachment {
  const json = JSON.stringify({ image: 'nginx', port: '80' });
  const bytes = new TextEncoder().encode(json);
  return { bytes, filename, size: bytes.length, hash: 'b'.repeat(64) };
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
  it('returns first endpoint URL (protocol stripped)', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '8080/tcp': 'http://1.2.3.4:32456' },
    })).toBe('1.2.3.4:32456');
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
    }, '1.2.3.4')).toBe('1.2.3.4:11111');
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

  it('returns undefined for instances with fqdn but no ports or endpoints', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      instances: [
        { name: 'web-0', status: 'running', fqdn: '0-abc1234.barney8.manifest0.net' },
        { name: 'web-1', status: 'running', fqdn: '1-def5678.barney8.manifest0.net' },
      ],
    })).toBeUndefined();
  });

  it('rewrites FQDN HTTP endpoint to https:// without port', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '80/tcp': 'http://25e0a20.barney0.manifest0.net:32772' },
    })).toBe('https://25e0a20.barney0.manifest0.net');
  });

  it('rewrites FQDN TCP-only endpoint to bare fqdn:port', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '5432/tcp': 'http://pg-abc.barney0.manifest0.net:31234' },
    })).toBe('pg-abc.barney0.manifest0.net:31234');
  });

  it('strips protocol from IP endpoint URL', () => {
    expect(extractUrlFromFredStatus({
      state: LeaseState.LEASE_STATE_ACTIVE,
      endpoints: { '80/tcp': 'http://1.2.3.4:32456' },
    })).toBe('1.2.3.4:32456');
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

describe('stack FQDN promotion', () => {
  it('promotes primary service fqdn to formatConnectionUrl for stack deployments', () => {
    const connection = {
      host: '64.29.115.29',
      // No top-level fqdn
      services: {
        db: { instances: [{ ports: { '3306/tcp': 32100 } }] },
        wordpress: {
          fqdn: 'wp-abc123.barney8.manifest0.net',
          instances: [{ ports: { '80/tcp': 32769 } }],
        },
      },
    };

    // Simulate what resolveAppUrl / executeAppStatus now do
    const primary = extractPrimaryServicePorts(connection.services);
    expect(primary).toBeDefined();

    let fqdn: string | undefined;
    if (primary && connection.services) {
      const svc = (connection.services as Record<string, { fqdn?: string; instances?: { fqdn?: string }[] }>)[primary!.serviceName];
      fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    }

    const withPorts = { ...connection, ports: primary!.ports, fqdn };
    expect(formatConnectionUrl(connection.host, withPorts)).toBe('https://wp-abc123.barney8.manifest0.net');
  });

  it('falls back to IP:port when primary service has no fqdn', () => {
    const connection = {
      host: '64.29.115.29',
      services: {
        db: { instances: [{ ports: { '3306/tcp': 32100 } }] },
        wordpress: { instances: [{ ports: { '80/tcp': 32769 } }] },
      },
    };

    const primary = extractPrimaryServicePorts(connection.services);
    expect(primary).toBeDefined();

    let fqdn: string | undefined;
    if (primary && connection.services) {
      const svc = (connection.services as Record<string, { fqdn?: string; instances?: { fqdn?: string }[] }>)[primary!.serviceName];
      fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    }

    const withPorts = { ...connection, ports: primary!.ports, fqdn };
    expect(formatConnectionUrl(connection.host, withPorts)).toBe('64.29.115.29:32769');
  });

  it('uses instance fqdn when service-level fqdn is absent', () => {
    const connection = {
      host: '64.29.115.29',
      services: {
        wordpress: {
          instances: [{ ports: { '80/tcp': 32769 }, fqdn: 'inst-abc.barney8.manifest0.net' }],
        },
      },
    };

    const primary = extractPrimaryServicePorts(connection.services);
    let fqdn: string | undefined;
    if (primary && connection.services) {
      const svc = (connection.services as Record<string, { fqdn?: string; instances?: { fqdn?: string }[] }>)[primary!.serviceName];
      fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    }

    const withPorts = { ...connection, ports: primary!.ports, fqdn };
    expect(formatConnectionUrl(connection.host, withPorts)).toBe('https://inst-abc.barney8.manifest0.net');
  });

  it('preserves top-level fqdn over service fqdn', () => {
    const connection = {
      host: '64.29.115.29',
      fqdn: 'top-level.barney8.manifest0.net',
      services: {
        wordpress: {
          fqdn: 'svc-level.barney8.manifest0.net',
          instances: [{ ports: { '80/tcp': 32769 } }],
        },
      },
    };

    // Top-level fqdn exists, so promotion is skipped (matching the if (!fqdn) guard)
    const primary = extractPrimaryServicePorts(connection.services);
    let fqdn: string | undefined = connection.fqdn;
    if (!fqdn && primary && connection.services) {
      const svc = (connection.services as Record<string, { fqdn?: string; instances?: { fqdn?: string }[] }>)[primary!.serviceName];
      fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    }

    const withPorts = { ...connection, ports: primary!.ports, fqdn };
    expect(formatConnectionUrl(connection.host, withPorts)).toBe('https://top-level.barney8.manifest0.net');
  });
});

describe('formatConnectionUrl', () => {
  it('returns bare host (no protocol)', () => {
    expect(formatConnectionUrl('example.com')).toBe('example.com');
  });

  it('strips existing protocol', () => {
    expect(formatConnectionUrl('https://example.com:443')).toBe('example.com:443');
  });

  it('returns host:port from connection.ports', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      ports: { '8080/tcp': { host_ip: '1.2.3.4', host_port: 32456 } },
    })).toBe('1.2.3.4:32456');
  });

  it('prefers connection.host over host param', () => {
    expect(formatConnectionUrl('fallback', {
      host: 'https://my-app.example.com',
      ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 12345 } },
    })).toBe('my-app.example.com:12345');
  });

  it('returns host:port even for standard ports', () => {
    expect(formatConnectionUrl('example.com', {
      host: 'example.com',
      ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 443 } },
    })).toBe('example.com:443');
  });

  it('returns undefined when no host', () => {
    expect(formatConnectionUrl(undefined)).toBeUndefined();
  });

  it('handles Docker PascalCase port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': { HostIp: '0.0.0.0', HostPort: '32456' } },
    })).toBe('127.0.0.1:32456');
  });

  it('handles Docker array port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '32789' }] },
    })).toBe('127.0.0.1:32789');
  });

  it('handles plain number port format', () => {
    expect(formatConnectionUrl('127.0.0.1', {
      host: '127.0.0.1',
      ports: { '8080/tcp': 12345 },
    })).toBe('127.0.0.1:12345');
  });

  it('returns https://fqdn for HTTP ports (Traefik-routed)', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'a1b2c3d.barney8.manifest0.net',
      ports: { '8080/tcp': { host_ip: '1.2.3.4', host_port: 32456 } },
    })).toBe('https://a1b2c3d.barney8.manifest0.net');
  });

  it('returns https://fqdn without ports', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'myapp.barney7.manifest0.net',
    })).toBe('https://myapp.barney7.manifest0.net');
  });

  it('rejects fqdn with userinfo injection', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'legit.com@evil.com',
      ports: { '8080/tcp': { host_ip: '1.2.3.4', host_port: 32456 } },
    })).toBe('1.2.3.4:32456');
  });

  it('rejects fqdn with path injection', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'evil.com/phish',
    })).toBe('1.2.3.4');
  });

  it('returns fqdn:port for postgres with FQDN', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'pg-abc123.barney8.manifest0.net',
      ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 31234 } },
    })).toBe('pg-abc123.barney8.manifest0.net:31234');
  });

  it('returns host:port for postgres without FQDN', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 31234 } },
    })).toBe('1.2.3.4:31234');
  });

  it('returns https://fqdn when port mapping has no extractable value', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      fqdn: 'pg.barney8.manifest0.net',
      ports: { '5432/tcp': {} },
    })).toBe('https://pg.barney8.manifest0.net');
  });

  it('strips protocol from metadata url fallback', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      metadata: { url: 'https://my-app.example.com' },
    })).toBe('my-app.example.com');
  });

  it('extracts host:port from metadata url, stripping path and userinfo', () => {
    expect(formatConnectionUrl('1.2.3.4', {
      host: '1.2.3.4',
      metadata: { url: 'https://user@my-app.example.com:8080/path?q=1' },
    })).toBe('my-app.example.com:8080');
  });
});

describe('stack FQDN promotion — standalone service', () => {
  it('returns fqdn:port for standalone postgres with FQDN', () => {
    const connection = {
      host: '64.29.115.29',
      services: {
        db: {
          fqdn: 'pg-abc123.barney8.manifest0.net',
          instances: [{ ports: { '5432/tcp': 31234 } }],
        },
      },
    };

    const primary = extractPrimaryServicePorts(connection.services);
    expect(primary).toBeDefined();

    let fqdn: string | undefined;
    if (primary && connection.services) {
      const svc = (connection.services as Record<string, { fqdn?: string; instances?: { fqdn?: string }[] }>)[primary!.serviceName];
      fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
    }

    const withPorts = { ...connection, ports: primary!.ports, fqdn };
    expect(formatConnectionUrl(connection.host, withPorts)).toBe('pg-abc123.barney8.manifest0.net:31234');
  });
});

describe('deriveUrlFromConnection', () => {
  it('shapes a top-level-port URL', () => {
    const out = deriveUrlFromConnection({
      host: '127.0.0.1',
      ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } },
    });
    expect(out?.url).toBe('127.0.0.1:32456');
  });

  it('promotes instances[0].ports when top-level absent', () => {
    const out = deriveUrlFromConnection({
      host: '127.0.0.1',
      instances: [{ instance_index: 0, container_id: 'c', image: 'i', status: 'running', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } }],
    } as any);
    expect(out?.url).toBe('127.0.0.1:32000');
  });

  it('promotes a stack primary service port + fqdn', () => {
    const out = deriveUrlFromConnection({
      host: 'provider.example.com',
      services: {
        web: { fqdn: 'app.example.com', instances: [{ ports: { '3000/tcp': { host_port: 30001 } } }] },
        db: { instances: [{ ports: { '5432/tcp': { host_port: 30002 } } }] },
      },
    } as any);
    expect(out?.url).toBe('https://app.example.com');
    expect(out?.connection.fqdn).toBe('app.example.com');
  });

  it('returns undefined when nothing shapeable', () => {
    expect(deriveUrlFromConnection({ host: '' } as any)).toBeUndefined();
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

describe('extractServiceNamesFromPayload', () => {
  it('extracts from JSON stack manifest', () => {
    const json = JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } });
    const bytes = new TextEncoder().encode(json);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web', 'db']);
  });

  it('extracts from JSON stack manifest whose services carry no image key (leniency guard)', () => {
    // Guards the deliberately-lenient Barney-local isStackManifest/getServiceNames
    // that back this extraction. fred's strict isStackManifest requires `"image" in v`
    // per service and would return [] for image-less services — regressing this path.
    // Every other extraction test feeds services that already carry an image, so only
    // this one fails if the code ever swaps to fred's strict variant. See the KEPT LOCAL
    // note in src/ai/manifest.ts.
    const json = JSON.stringify({ services: { web: {}, db: {} } });
    const bytes = new TextEncoder().encode(json);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web', 'db']);
  });

  it('returns empty for JSON single-service manifest', () => {
    const json = JSON.stringify({ image: 'nginx', ports: { '80/tcp': {} } });
    const bytes = new TextEncoder().encode(json);
    expect(extractServiceNamesFromPayload(bytes)).toEqual([]);
  });

  it('extracts from YAML stack manifest', () => {
    const yaml = [
      'services:',
      '  web:',
      '    image: wordpress:6',
      '    ports:',
      '      80/tcp: {}',
      '  db:',
      '    image: mysql:9',
      '    env:',
      '      MYSQL_ROOT_PASSWORD: secret',
    ].join('\n');
    const bytes = new TextEncoder().encode(yaml);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web', 'db']);
  });

  it('extracts from YAML with comments', () => {
    const yaml = [
      '# Docker Compose stack',
      'services: # main services',
      '  frontend:',
      '    image: nginx',
      '  # backend database',
      '  backend-db:',
      '    image: postgres',
    ].join('\n');
    const bytes = new TextEncoder().encode(yaml);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['frontend', 'backend-db']);
  });

  it('stops at next top-level YAML key', () => {
    const yaml = [
      'services:',
      '  web:',
      '    image: nginx',
      'volumes:',
      '  data:',
      '    driver: local',
    ].join('\n');
    const bytes = new TextEncoder().encode(yaml);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web']);
  });

  it('returns empty for YAML single-service manifest', () => {
    const yaml = [
      'image: nginx',
      'ports:',
      '  80/tcp: {}',
    ].join('\n');
    const bytes = new TextEncoder().encode(yaml);
    expect(extractServiceNamesFromPayload(bytes)).toEqual([]);
  });

  it('returns empty for non-parseable content', () => {
    const bytes = new TextEncoder().encode('this is just plain text');
    expect(extractServiceNamesFromPayload(bytes)).toEqual([]);
  });

  it('filters out invalid service names from JSON and logs', () => {
    vi.mocked(logError).mockClear();
    const json = JSON.stringify({ services: {
      web: { image: 'nginx:1' },
      My_DB: { image: 'mysql:9' },
      db: { image: 'postgres:18' },
    }});
    const bytes = new TextEncoder().encode(json);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web', 'db']);
    expect(logError).toHaveBeenCalledWith(
      'extractServiceNamesFromPayload',
      expect.objectContaining({ message: expect.stringContaining('My_DB') }),
    );
  });

  it('filters out invalid service names from YAML and logs', () => {
    vi.mocked(logError).mockClear();
    const yaml = 'services:\n  web:\n    image: nginx\n  BAD_NAME:\n    image: redis\n  cache:\n    image: redis';
    const bytes = new TextEncoder().encode(yaml);
    expect(extractServiceNamesFromPayload(bytes)).toEqual(['web', 'cache']);
    expect(logError).toHaveBeenCalledWith(
      'extractServiceNamesFromPayload',
      expect.objectContaining({ message: expect.stringContaining('BAD_NAME') }),
    );
  });

  it('deduplicates service names', () => {
    const json = JSON.stringify({ services: {
      web: { image: 'nginx:1' },
    }});
    // JSON Object.keys won't produce dupes, but exercise the dedup path
    const bytes = new TextEncoder().encode(json);
    const result = extractServiceNamesFromPayload(bytes);
    expect(result).toEqual(['web']);
    expect(new Set(result).size).toBe(result.length);
  });

  it('returns empty for non-UTF-8 binary data', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(extractServiceNamesFromPayload(bytes)).toEqual([]);
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

  it('returns error for health_check.test with non-string elements', () => {
    const json = JSON.stringify({
      web: { image: 'nginx', health_check: { test: ['CMD-SHELL', 42] } },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('health_check.test must be an array of strings');
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

  it('returns error for labels with non-string values in stack service', () => {
    const json = JSON.stringify({
      web: { image: 'nginx', labels: { app: 'myapp', priority: 123 } },
    });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('label "priority" must have a string value');
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

  it('coerces numeric port to string', () => {
    const json = JSON.stringify({ web: { image: 'nginx', port: 80 } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.port).toBe('80');
    }
  });

  it('coerces numeric user to string', () => {
    const json = JSON.stringify({ db: { image: 'postgres', user: 999 } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.db.user).toBe('999');
    }
  });

  it('coerces tmpfs array to comma-separated string', () => {
    const json = JSON.stringify({ web: { image: 'nginx', tmpfs: ['/var/run', '/tmp'] } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.services.web.tmpfs).toBe('/var/run,/tmp');
    }
  });

  it('rejects object port with clear error', () => {
    const json = JSON.stringify({ web: { image: 'nginx', port: { tcp: 80 } } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('port must be a string');
      expect(result.error).toContain('Service "web"');
    }
  });

  it('rejects object user with clear error', () => {
    const json = JSON.stringify({ db: { image: 'postgres', user: { uid: 999 } } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('user must be a string');
      expect(result.error).toContain('Service "db"');
    }
  });

  it('rejects object tmpfs with clear error', () => {
    const json = JSON.stringify({ web: { image: 'nginx', tmpfs: { path: '/tmp' } } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('tmpfs must be a string or array');
    }
  });

  it('rejects tmpfs array with non-string elements', () => {
    const json = JSON.stringify({ web: { image: 'nginx', tmpfs: ['/var/run', 123] } });
    const result = parseAndValidateStackServices(json, false, 'test');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('tmpfs array element');
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

  it('falls back to the cheapest tier for an unavailable size instead of erroring', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    // No payload attached — exercises the image-based manifest-build path
    // (a payload would take precedence over `image` and, post-§3.9, would
    // need to be valid JSON, which is irrelevant to what this test covers).
    const result = await executeDeployApp({ image: 'redis', port: '6379', size: 'xxlarge' }, makeOptions());
    expect(result.success).toBe(true);
    // SAMPLE_TIERS cheapest is docker-micro (0.036/hr)
    expect(result.pendingAction?.args.size).toBe('docker-micro');
  });

  it('returns clean error when tier catalog is empty (loading/error state)', async () => {
    const result = await executeDeployApp({ image: 'redis' }, makeOptions({ tiers: [] }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tier catalog unavailable/i);
  });

  it('accepts both "micro" (legacy) and "docker-micro" (canonical) for size', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    const a = await executeDeployApp({ image: 'redis', port: '6379', size: 'micro' }, makeOptions());
    const b = await executeDeployApp({ image: 'redis', port: '6379', size: 'docker-micro' }, makeOptions());
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.pendingAction?.args.size).toBe('docker-micro');
    expect(b.pendingAction?.args.size).toBe('docker-micro');
  });

  it('accepts all valid size tiers', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', name: 'Provider', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);

    const result = await executeDeployApp({}, makeOptions(), makeJsonPayload());
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('docker-compose');
  });

  // Pass-16 regression catchers. Pre-pass-11, `pricePerHour === 0` was
  // ambiguous (free tier OR missing basePrice), so the executor's
  // `skuHourlyCost > 0` guard suppressed the display. Pass 11's basePrice
  // filter closed that ambiguity — `pricePerHour === 0` now unambiguously
  // means "genuinely free tier" (`basePrice.amount === '0'`), and the guard
  // is a billing-transparency bug. These tests pin the unconditional format.
  it('renders "0.0000 .../hr" on the confirmation message for a free tier (pass-16)', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-free', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const freeTier = [
      { skuName: 'docker-micro', skuUuid: 'sku-free', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0, denomSymbol: 'PWR', unit: 1 },
    ];
    const result = await executeDeployApp(
      { size: 'docker-micro' },
      makeOptions({ tiers: freeTier }),
      makeJsonPayload(),
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    // Unconditional formatter — pre-fix this assertion fails because the
    // `> 0` guard yielded `priceDisplay = ''` and the ` (~…)` wrapper was
    // suppressed entirely.
    expect(result.confirmationMessage).toContain('0.0000 PWR/hr');
  });

  it('still renders the price display for a positive-price tier (pass-16 happy-path regression)', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const result = await executeDeployApp(
      { size: 'docker-micro' },
      makeOptions(),
      makeJsonPayload(),
    );

    expect(result.success).toBe(true);
    // SAMPLE_TIERS docker-micro is 0.036 PWR/hr — pinning the existing
    // wording so a regression that flips it back to a `> 0` guard would
    // still pass this test (no false positive) but the free-tier test
    // above would fail (the regression catcher).
    expect(result.confirmationMessage).toContain('0.0360 PWR/hr');
  });

  it('builds manifest from image when no payload', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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

  it('defaults to the cheapest resolved tier when size is omitted', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    // Arrange so the cheapest tier (docker-small @ 0.01 PWR/hr) is NOT tiers[0].
    // The default must follow price, not insertion order, so this catches a
    // tiers[0]-based regression that the SAMPLE_TIERS default would silently miss.
    const tiersOutOfPriceOrder = [
      { skuName: 'docker-large', skuUuid: 'sku-l', providerUuid: 'p1', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-medium', skuUuid: 'sku-m', providerUuid: 'p1', cores: 2, ramMB: 2048, diskGB: 10, pricePerHour: 0.2, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-small', skuUuid: 'sku-s', providerUuid: 'p1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.01, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-micro', skuUuid: 'sku-mi', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
    ];

    const result = await executeDeployApp(
      { image: 'nginx:latest', port: '80' },
      makeOptions({ tiers: tiersOutOfPriceOrder })
    );

    expect(result.success).toBe(true);
    expect(result.pendingAction?.args.size).toBe('docker-small');
  });

  it('applies known image defaults when model omits args', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
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
  });

  it('model-provided values override known image defaults', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'redis:8.4' },
      makeOptions(),
      makeJsonPayload()  // file takes precedence
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    // Should use filename-derived name, not image-derived
    expect(result.confirmationMessage).toContain('docker-compose');
    // Valid JSON file uploads are always captured as the editable manifest
    // (§3.9 — the old .json-extension-only gate is gone).
    expect(result.pendingAction?.args._generatedManifest).toBeDefined();
  });

  it('returns confirmation for stack deploy with services param', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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

  it('extracts service names from file-uploaded stack manifest payload', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const stackManifest = {
      services: {
        web: { image: 'wordpress:6', ports: { '80/tcp': {} }, env: { WORDPRESS_DB_HOST: 'db:3306' } },
        db: { image: 'mysql:9', env: { MYSQL_ROOT_PASSWORD: 'secret' } },
      },
    };
    const json = JSON.stringify(stackManifest, null, 2);
    const bytes = new TextEncoder().encode(json);
    const payload: PayloadAttachment = {
      bytes,
      filename: 'docker-compose.json',
      size: bytes.length,
      hash: 'c'.repeat(64),
    };

    const result = await executeDeployApp({}, makeOptions(), payload);

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args._serviceNames).toEqual(['web', 'db']);
  });

  // Pre-§3.9, a YAML stack manifest fell through the (then extension-gated)
  // JSON check and still reached service-name extraction / confirmation.
  // §3.9 closes that: any non-JSON file content is rejected in the plan
  // phase, so a YAML stack upload can no longer reach this far (it's also
  // blocked earlier, at the file picker, by ALLOWED_FILE_EXTENSIONS — this
  // is the belt-and-suspenders guard for content that slips past that).
  it('rejects a file-uploaded YAML stack manifest instead of extracting service names', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const yaml = [
      'services:',
      '  web:',
      '    image: wordpress:6',
      '    ports:',
      '      80/tcp: {}',
      '  db:',
      '    image: mysql:9',
      '    env:',
      '      MYSQL_ROOT_PASSWORD: secret',
    ].join('\n');
    const bytes = new TextEncoder().encode(yaml);
    const payload: PayloadAttachment = {
      bytes,
      filename: 'docker-compose.yml',
      size: bytes.length,
      hash: 'd'.repeat(64),
    };

    const result = await executeDeployApp({}, makeOptions(), payload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Manifest must be valid JSON — convert your YAML to JSON.');
  });

  it('returns error for invalid internal _serviceNames metadata', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'redis:8.4', _serviceNames: 'web' },
      makeOptions()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid stack service metadata');
  });

  it('coerces numeric port to string for single-service deploy', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    const result = await executeDeployApp(
      { image: 'nginx', port: 80 as unknown as string },
      makeOptions()
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    const manifest = JSON.parse(result.pendingAction!.args._generatedManifest as string);
    expect(manifest.ports).toEqual({ '80/tcp': {} });
  });

  it('rejects object port with clear error for single-service deploy', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', port: { tcp: 80 } as unknown as string },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('port must be a string');
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

  it('returns error for health_check.test with non-string elements in deploy', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', health_check: '{"test":["CMD-SHELL",123]}' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('health_check.test must be an array of strings');
  });

  it('passes stop_grace_period, init, expose, labels through to manifest', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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

  it('returns error for labels with non-string values in deploy', async () => {
    const result = await executeDeployApp(
      { image: 'nginx', labels: '{"app":"myapp","count":42}' },
      makeOptions()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Label "count" must have a string value, got number');
  });

  it('applies known image health_check default for postgres deploy', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-small', name: 'docker-small', providerUuid: 'p1' } as any,
    ]);
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

  it('rejects a non-JSON file upload with a convert-to-JSON error', async () => {
    const payload: PayloadAttachment = {
      bytes: new TextEncoder().encode('image: nginx\nport: "80"\n'),
      filename: 'compose.txt',
      size: 24,
      hash: 'deadbeef',
    };
    const result = await executeDeployApp({}, makeOptions(), payload);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Manifest must be valid JSON — convert your YAML to JSON.');
  });

  it('accepts a valid JSON file upload and stores it as the editable manifest', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com' },
    ] as any);
    vi.mocked(getCreditAccount).mockResolvedValue({
      balances: [{ denom: DENOMS.PWR, amount: '100000000' }],
    } as any);
    const json = JSON.stringify({ image: 'nginx', port: '80' });
    const payload: PayloadAttachment = {
      bytes: new TextEncoder().encode(json),
      filename: 'app.json',
      size: json.length,
      hash: 'abc123',
    };
    const result = await executeDeployApp({}, makeOptions(), payload);
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    if (result.success && result.requiresConfirmation) {
      expect(result.pendingAction.args._generatedManifest).toBe(json);
    }
  });
});

describe('executeConfirmedDeployApp', () => {
  beforeEach(() => vi.clearAllMocks());

  // deployManifest stub: fire onLeaseCreated (registry addApp + uploading phase),
  // one provisioning progress tick, then resolve with the given DeployResult.
  function mockDeploySuccess(result: Partial<import('@manifest-network/manifest-mcp-core').DeployResult>) {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      opts?.pollOptions?.onProgress?.({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'provisioning' } as any);
      return {
        lease_uuid: 'new-lease-uuid',
        provider_uuid: 'p1',
        provider_url: 'https://fred.example.com',
        state: LeaseState.LEASE_STATE_ACTIVE,
        ...result,
      } as any;
    });
  }

  const ARGS = { app_name: 'test-app', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com' };

  it('deploys via deployManifest and shapes URL from connection (top-level ports)', async () => {
    mockDeploySuccess({
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry, onProgress }), makePayload());

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBe('127.0.0.1:32456');
    // does NOT consume DeployResult.url
    expect(deployManifest).toHaveBeenCalledTimes(1);
    expect(cosmosTx).not.toHaveBeenCalled();
    expect(uploadPayloadToProvider).not.toHaveBeenCalled();
    expect(waitForLeaseReady).not.toHaveBeenCalled();
    expect(setItemCustomDomain).not.toHaveBeenCalled();
    // registry addApp(deploying) fired in onLeaseCreated, then updateApp(running)
    expect(registry.addApp).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ status: 'deploying', leaseUuid: 'new-lease-uuid' }));
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', expect.objectContaining({ status: 'running', url: '127.0.0.1:32456' }));
    // progress sequence
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'creating_lease' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'uploading' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'provisioning' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
    // app displayCard
    expect(result.success && !result.requiresConfirmation && result.displayCard?.type).toBe('app');
  });

  it('builds a kind:resolved spec with the _notice-stripped manifest', async () => {
    mockDeploySuccess({ connection: { host: '127.0.0.1', ports: { '80/tcp': { host_port: 1 } } } });
    const json = JSON.stringify({ image: 'nginx', port: '80', _notice: 'display-only' });
    await executeConfirmedDeployApp(
      { ...ARGS, _generatedManifest: json },
      CLIENT_MANAGER,
      makeOptions(),
      undefined,
    );
    const [, spec] = vi.mocked(deployManifest).mock.calls[0];
    expect(spec.sku).toEqual({ kind: 'resolved', skuUuid: 'sku-1', providerUuid: 'p1' });
    expect(spec.manifest).not.toContain('_notice');
    expect(JSON.parse(spec.manifest)).toEqual({ image: 'nginx', port: '80' });
    expect(spec.customDomain).toBeUndefined();
    expect(spec.serviceName).toBeUndefined();
  });

  it('passes customDomain into the spec and omits empty serviceName', async () => {
    mockDeploySuccess({ connection: { host: '127.0.0.1', ports: { '80/tcp': { host_port: 1 } } }, custom_domain: 'app.example.com' });
    await executeConfirmedDeployApp(
      { ...ARGS, customDomain: 'app.example.com', customDomainServiceName: '' },
      CLIENT_MANAGER,
      makeOptions(),
      makePayload(),
    );
    const [, spec] = vi.mocked(deployManifest).mock.calls[0];
    expect(spec.customDomain).toBe('app.example.com');
    expect('serviceName' in spec).toBe(false);
    // barney no longer double-sets the domain itself
    expect(setItemCustomDomain).not.toHaveBeenCalled();
  });

  it('includes serviceName only alongside a non-empty customDomain', async () => {
    mockDeploySuccess({ connection: { host: '127.0.0.1', ports: { '80/tcp': { host_port: 1 } } }, custom_domain: 'app.example.com', service_name: 'web' });
    await executeConfirmedDeployApp(
      { ...ARGS, customDomain: 'app.example.com', customDomainServiceName: 'web' },
      CLIENT_MANAGER,
      makeOptions(),
      makePayload(),
    );
    const [, spec] = vi.mocked(deployManifest).mock.calls[0];
    expect(spec.serviceName).toBe('web');
  });

  it('falls back to resolveAppUrl when DeployResult.connection is absent', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return { lease_uuid: 'new-lease-uuid', provider_uuid: 'p1', provider_url: 'https://fred.example.com', state: LeaseState.LEASE_STATE_ACTIVE, connectionError: 'boom' } as any;
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '9.9.9.9', ports: { '80/tcp': { host_port: 40000 } } },
    } as any);
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions(), makePayload());
    expect(result.success).toBe(true);
    expect((result.data as any).url).toBe('9.9.9.9:40000');
    expect(getLeaseConnectionInfo).toHaveBeenCalled();
  });

  it('routes a deployManifest throw through handleDeployManifestError (chain ACTIVE → running)', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll timeout', { partial: true });
    });
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry }), makePayload());
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', { status: 'running' });
  });

  it('surfaces a create-lease raw error (case 1, no lease)', async () => {
    vi.mocked(deployManifest).mockRejectedValue(new Error('insufficient funds'));
    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry, onProgress }), makePayload());
    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient funds');
    expect(registry.addApp).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }));
  });

  it('rejects when payload is missing', async () => {
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions(), undefined);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload missing');
  });

  it('rejects when wallet cannot sign', async () => {
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ signing: undefined }), makePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support message signing');
  });
});

describe('executeStopApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for nonexistent app', async () => {
    const result = await executeStopApp({ app_name: 'ghost' }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No unique app found matching');
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

  it('returns confirmation for stop all with multiple running apps', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
      makeApp({ name: 'stopped-app', leaseUuid: 'uuid-3', status: 'stopped' }),
    ];
    const result = await executeStopApp({ app_name: 'all' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.pendingAction?.args.entries).toHaveLength(2);
  });

  it('returns error when no running apps for stop all', async () => {
    const apps = [makeApp({ name: 'stopped', leaseUuid: 'uuid-1', status: 'stopped' })];
    const result = await executeStopApp({ app_name: 'all' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No eligible apps to stop');
  });

  it('returns confirmation for comma-separated stop', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
      makeApp({ name: 'nginx', leaseUuid: 'uuid-3' }),
    ];
    const result = await executeStopApp({ app_name: 'redis,postgres' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.pendingAction?.args.entries).toHaveLength(2);
  });

  it('returns error when comma-separated name not found', async () => {
    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1' })];
    const result = await executeStopApp({ app_name: 'redis,ghost' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('ghost');
  });

  it('returns error when all comma-separated apps are ineligible', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', status: 'stopped' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', status: 'stopped' }),
    ];
    const result = await executeStopApp({ app_name: 'redis,postgres' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No eligible apps to stop');
  });

  it('includes skipped apps in confirmation when some are ineligible', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', status: 'running' }),
      makeApp({ name: 'stopped-app', leaseUuid: 'uuid-2', status: 'stopped' }),
    ];
    const result = await executeStopApp({ app_name: 'redis,stopped-app' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args.entries).toHaveLength(1);
    expect(result.confirmationMessage).toContain('skipped');
    expect(result.confirmationMessage).toContain('stopped-app');
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

  it('stops multiple apps in bulk and returns summary', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));

    const result = await executeConfirmedStopApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).stopped).toEqual(['redis', 'postgres']);
    expect((result.data as any).failed).toHaveLength(0);
    expect(cosmosTx).toHaveBeenCalledTimes(2);
  });

  it('handles partial failures in bulk stop', async () => {
    vi.mocked(cosmosTx)
      .mockResolvedValueOnce({ code: 0, transactionHash: 'hash', rawLog: '' } as any)
      .mockResolvedValueOnce({ code: 1, rawLog: 'some error' } as any);

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));

    const result = await executeConfirmedStopApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).stopped).toEqual(['redis']);
    expect((result.data as any).failed).toEqual(['postgres']);
  });

  it('treats lease-not-active as success in bulk stop', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 1, rawLog: 'lease not active' } as any);

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1' })];
    const registry = makeRegistry(apps);
    const entries = [{ app_name: 'redis', leaseUuid: 'uuid-1' }];

    const result = await executeConfirmedStopApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).stopped).toEqual(['redis']);
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'uuid-1', { status: 'stopped' });
  });

  it('returns failure when all bulk stops fail', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 1, rawLog: 'error' } as any);

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));

    const result = await executeConfirmedStopApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to stop');
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

  it('batch falls back to the cheapest tier for an unavailable size', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);
    const result = await executeBatchDeploy([makeBatchEntry('app1')], makeOptions(), 'xxlarge');
    expect(result.success).toBe(true);
    const entries = result.pendingAction?.args.entries as Array<{ size: string }>;
    expect(entries[0].size).toBe('docker-micro'); // SAMPLE_TIERS cheapest
  });

  it('batch defaults to the cheapest resolved tier when size is omitted', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    // Arrange so the cheapest tier (docker-small @ 0.01 PWR/hr) is NOT tiers[0].
    // A `tiers[0]`-based regression would silently pass against SAMPLE_TIERS;
    // this ordering forces the test to rely on price comparison.
    const tiersOutOfPriceOrder = [
      { skuName: 'docker-large', skuUuid: 'sku-l', providerUuid: 'p1', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-small', skuUuid: 'sku-s', providerUuid: 'p1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.01, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-micro', skuUuid: 'sku-mi', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
    ];

    const result = await executeBatchDeploy(
      [makeBatchEntry('app1')],
      makeOptions({ tiers: tiersOutOfPriceOrder }),
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    const entries = result.pendingAction?.args.entries as Array<{ size: string }>;
    expect(entries[0].size).toBe('docker-small');
  });

  it('returns confirmation for valid batch', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
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

  // Pass-16 batch-side regression catchers. Mirrors the single-deploy pair
  // above. Pre-fix, the batch `confirmationMessage` template
  // `... tier${priceDisplay ? ` (~${priceDisplay} each)` : ''}?` dropped the
  // price wrapper entirely when priceDisplay was empty — and priceDisplay
  // was empty whenever pricePerHour was 0 (the pass-11-now-incorrect guard).
  it('renders "0.0000 .../hr" on the batch confirmation message for a free tier (pass-16)', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-free', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const freeTier = [
      { skuName: 'docker-micro', skuUuid: 'sku-free', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0, denomSymbol: 'PWR', unit: 1 },
    ];
    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2')];
    const result = await executeBatchDeploy(entries, makeOptions({ tiers: freeTier }));

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('0.0000 PWR/hr');
    // totalHourlyCost = 0 × 2 entries = 0; the credit check's
    // `if (totalHourlyCost > 0 && credits < totalHourlyCost)` branch is
    // skipped, so no Insufficient-credits error fires for the free tier
    // even when getCreditAccount returns null.
    expect(result.error).toBeUndefined();
  });

  it('still renders the price display for a positive-price batch tier (pass-16 happy-path regression)', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2')];
    const result = await executeBatchDeploy(entries, makeOptions());

    expect(result.success).toBe(true);
    // Default SAMPLE_TIERS docker-micro is 0.036 PWR/hr — same pin as the
    // single-deploy happy-path regression catcher.
    expect(result.confirmationMessage).toContain('0.0360 PWR/hr');
  });

  it('returns insufficient credits error when total cost exceeds balance', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    // 0.5 PWR balance with tier price 1 PWR/hour × 3 entries = need 3, have 0.5
    vi.mocked(getCreditAccount).mockResolvedValue({
      balances: [{ denom: 'upwr', amount: '500000' }],
    } as any);

    const tiersWithHighPrice = SAMPLE_TIERS.map(t => ({ ...t, pricePerHour: 1.0 }));
    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2'), makeBatchEntry('app3')];
    const result = await executeBatchDeploy(entries, makeOptions({ tiers: tiersWithHighPrice }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
  });

  it('extracts service names from stack manifest payloads', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
    ]);
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);

    const stackManifest = {
      services: {
        web: { image: 'wordpress:6', ports: { '80/tcp': {} }, env: { WORDPRESS_DB_HOST: 'db:3306' } },
        db: { image: 'mysql:9', env: { MYSQL_ROOT_PASSWORD: 'secret' } },
      },
    };
    const json = JSON.stringify(stackManifest, null, 2);
    const bytes = new TextEncoder().encode(json);
    const entry: BatchDeployEntry = {
      app_name: 'wordpress',
      payload: { bytes, filename: 'manifest-wordpress.json', size: bytes.length, hash: 'b'.repeat(64) },
    };

    const result = await executeBatchDeploy([entry], makeOptions());

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    const resolvedEntries = result.pendingAction?.args.entries as any[];
    expect(resolvedEntries).toHaveLength(1);
    expect(resolvedEntries[0].serviceNames).toEqual(['web', 'db']);
  });

  it('counts services (not just entries) for credit check on stack deploys', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);
    // 1.5 credits: enough for 1 entry but not 2 services at 1 PWR/hr each
    vi.mocked(getCreditAccount).mockResolvedValue({
      balances: [{ denom: 'upwr', amount: '1500000' }],
    } as any);

    const stackManifest = {
      services: {
        web: { image: 'wordpress:6', ports: { '80/tcp': {} } },
        db: { image: 'mysql:9' },
      },
    };
    const json = JSON.stringify(stackManifest, null, 2);
    const bytes = new TextEncoder().encode(json);
    const entry: BatchDeployEntry = {
      app_name: 'wordpress',
      payload: { bytes, filename: 'manifest-wordpress.json', size: bytes.length, hash: 'b'.repeat(64) },
    };

    const tiersWithHighPrice = SAMPLE_TIERS.map(t => ({ ...t, pricePerHour: 1.0 }));
    // 1 entry with 2 services → needs 2 credits, but only 1.5 available
    const result = await executeBatchDeploy([entry], makeOptions({ tiers: tiersWithHighPrice }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
    expect(result.error).toContain('2 services');
  });
});

describe('executeConfirmedBatchDeploy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for empty entries', async () => {
    const result = await executeConfirmedBatchDeploy({ entries: [] }, CLIENT_MANAGER, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No entries');
  });

  it('deploys all apps in parallel via deployManifest and reports results', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });

    const onProgress = vi.fn();
    const registry = makeRegistry();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
      { app_name: 'game2', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    const opts = makeOptions({ appRegistry: registry, onProgress });
    // §3.11: deployManifest must NOT be wrapped in signing.withSign (deadlock).
    const withSignSpy = vi.spyOn(opts.signing!, 'withSign');

    const result = await executeConfirmedBatchDeploy({ entries }, CLIENT_MANAGER, opts);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.deployed).toHaveLength(2);
    expect(data.deployed.map((d: any) => d.name)).toEqual(expect.arrayContaining(['game1', 'game2']));
    expect(data.failed).toHaveLength(0);
    expect(deployManifest).toHaveBeenCalledTimes(2);
    expect(withSignSpy).not.toHaveBeenCalled();
    // Batch delegates domain attach to deployManifest — never a direct set call.
    expect(setItemCustomDomain).not.toHaveBeenCalled();
    const lastProgress = onProgress.mock.calls.at(-1)![0];
    expect(lastProgress.batch).toBeDefined();
  });

  it('records a raw create-lease rejection in failed[] and keeps the rest', async () => {
    vi.mocked(deployManifest)
      .mockImplementationOnce(async (_ctx, _spec, callOptions) => {
        await callOptions?.onLeaseCreated?.('lease-1', 'https://fred.example.com');
        return makeDeployResult();
      })
      .mockRejectedValueOnce(new Error('insufficient funds'));

    const registry = makeRegistry();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
      { app_name: 'game2', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    const result = await executeConfirmedBatchDeploy({ entries }, CLIENT_MANAGER, makeOptions({ appRegistry: registry }));

    expect(result.success).toBe(true);
    expect((result.data as any).deployed.map((d: any) => d.name)).toContain('game1');
    expect((result.data as any).failed).toContain('game2');
  });

  describe('custom domain (in-deploy)', () => {
    function mockDeploy() {
      vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
        await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
        return makeDeployResult();
      });
    }

    it('passes customDomain into the deploy spec and never calls setItemCustomDomain', async () => {
      mockDeploy();
      const entries = [
        { app_name: 'a1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload(), customDomain: 'a1.example.com' },
      ];
      await executeConfirmedBatchDeploy({ entries }, CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect(spec.customDomain).toBe('a1.example.com');
      expect(spec.serviceName).toBeUndefined();
      expect(setItemCustomDomain).not.toHaveBeenCalled();
    });

    it('passes serviceName into the spec for a multi-service stack entry', async () => {
      mockDeploy();
      const entries = [
        { app_name: 'wp', size: 'small', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload(), serviceNames: ['web', 'db'], customDomain: 'wp.example.com', customDomainServiceName: 'web' },
      ];
      await executeConfirmedBatchDeploy({ entries }, CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect(spec.customDomain).toBe('wp.example.com');
      expect(spec.serviceName).toBe('web');
    });

    it('omits customDomain and serviceName from the spec when the entry has none', async () => {
      mockDeploy();
      const entries = [
        { app_name: 'plain', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
      ];
      await executeConfirmedBatchDeploy({ entries }, CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect('customDomain' in spec).toBe(false);
      expect('serviceName' in spec).toBe(false);
    });
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
    expect(result.error).toContain('No unique app found matching');
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

  it('returns confirmation for restart all with multiple running apps', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
      makeApp({ name: 'stopped-app', leaseUuid: 'uuid-3', status: 'stopped' }),
    ];
    const result = await executeRestartApp({ app_name: 'all' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.pendingAction?.args.entries).toHaveLength(2);
  });

  it('returns error when no running apps for restart all', async () => {
    const apps = [makeApp({ name: 'stopped', leaseUuid: 'uuid-1', status: 'stopped' })];
    const result = await executeRestartApp({ app_name: 'all' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No eligible apps to restart');
  });

  it('filters out apps without providerUrl for restart all', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred.example.com' }),
      makeApp({ name: 'no-provider', leaseUuid: 'uuid-2', providerUrl: undefined }),
    ];
    const result = await executeRestartApp({ app_name: 'all' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.pendingAction?.args.entries).toHaveLength(1);
    expect((result.pendingAction?.args.entries as any[])[0].app_name).toBe('redis');
  });

  it('returns confirmation for comma-separated restart', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
      makeApp({ name: 'nginx', leaseUuid: 'uuid-3', providerUrl: 'https://fred3.example.com' }),
    ];
    const result = await executeRestartApp({ app_name: 'redis,postgres' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.pendingAction?.args.entries).toHaveLength(2);
  });

  it('returns error when comma-separated name not found', async () => {
    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1' })];
    const result = await executeRestartApp({ app_name: 'redis,ghost' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('ghost');
  });

  it('returns error when all comma-separated apps are ineligible', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', status: 'stopped' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', status: 'stopped' }),
    ];
    const result = await executeRestartApp({ app_name: 'redis,postgres' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No eligible apps to restart');
  });

  it('includes skipped apps in confirmation when some are ineligible', async () => {
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', status: 'running', providerUrl: 'https://fred.example.com' }),
      makeApp({ name: 'stopped-app', leaseUuid: 'uuid-2', status: 'stopped' }),
    ];
    const result = await executeRestartApp({ app_name: 'redis,stopped-app' }, makeOptions({ appRegistry: makeRegistry(apps) }));
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingAction?.args.entries).toHaveLength(1);
    expect(result.confirmationMessage).toContain('skipped');
    expect(result.confirmationMessage).toContain('stopped-app');
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

  it('restarts multiple apps in batch and returns summary', async () => {
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
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({
      app_name: a.name,
      leaseUuid: a.leaseUuid,
      providerUrl: a.providerUrl!,
    }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).restarted).toHaveLength(2);
    expect((result.data as any).failed).toHaveLength(0);
    expect(restartLease).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'restart',
      batch: expect.arrayContaining([
        expect.objectContaining({ name: 'redis' }),
        expect.objectContaining({ name: 'postgres' }),
      ]),
    }));
  });

  it('handles partial failures in batch restart', async () => {
    // First app succeeds, second fails with 409
    vi.mocked(restartLease)
      .mockResolvedValueOnce({ status: 'restarting' })
      .mockRejectedValueOnce(new ProviderApiError(409, 'not restartable'));
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

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({
      app_name: a.name,
      leaseUuid: a.leaseUuid,
      providerUrl: a.providerUrl!,
    }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).restarted).toHaveLength(1);
    expect((result.data as any).failed).toHaveLength(1);
    expect((result.data as any).failed[0]).toBe('postgres');
  });

  it('returns failure when all batch restarts fail', async () => {
    vi.mocked(restartLease).mockRejectedValue(new ProviderApiError(409, 'not restartable'));

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({
      app_name: a.name,
      leaseUuid: a.leaseUuid,
      providerUrl: a.providerUrl!,
    }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('All restarts failed');
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

  it('returns error for invalid internal stack service metadata in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', _isStack: true, _serviceNames: 'web' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid stack service metadata');
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
    // Fred always includes ports in output (empty when none specified)
    expect(manifest.services.db.ports).toEqual({});
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

  it('returns error for health_check.test with non-string elements in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', health_check: '{"test":["CMD-SHELL",null]}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('health_check.test must be an array of strings');
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

  it('returns error for labels with non-string values in update', async () => {
    const app = makeApp();
    const result = await executeUpdateApp(
      { app_name: 'my-app', image: 'nginx', labels: '{"env":"prod","enabled":true}' },
      makeOptions({ appRegistry: makeRegistry([app]) })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Label "enabled" must have a string value, got boolean');
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

  it('normalizes trailing-period on provision.last_error in rollback-failed branch', async () => {
    // Pass-9 follow-up: site 4. The "Update failed and rollback failed.
    // Last error: …. Use app_status(…) to check." template embeds the
    // provision.last_error mid-sentence; without normalization an upstream
    // error ending in `.` would double-up.
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
    // Rollback failed: status='failed' + last_error ending in `.`.
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed',
      fail_count: 1,
      last_error: 'health check kept timing out.',
    });

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Update failed and rollback failed.');
    expect(result.error).toContain('health check kept timing out.');
    expect(result.error).not.toMatch(/\.\./);
    // Sentence boundary survives: tail-stripped `.` then template's own `.`
    // then the next sentence.
    expect(result.error).toContain('timing out. Use app_status');
  });
});

describe('deploy_app with custom_domain (Pass B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', address: 'p-addr', payoutAddress: 'p-addr', metaHash: new Uint8Array(), active: true, apiUrl: 'https://prov.example' },
    ]);
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-micro', providerUuid: 'p1', name: 'docker-micro', basePrice: { amount: '10', denom: 'upwr' }, unit: Unit.UNIT_PER_DAY } as any,
    ]);
    vi.mocked(getCreditAccount).mockResolvedValue({
      creditAccount: { tenant: 'addr', creditAddress: 'caddr', activeLeaseCount: 0n, pendingLeaseCount: 0n, reservedAmounts: [] },
      balances: [{ denom: DENOMS.PWR, amount: '999000000' }],
      availableBalances: [{ denom: DENOMS.PWR, amount: '999000000' }],
    });
  });

  it('executeDeployApp validates custom_domain format', async () => {
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'not a domain' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/not a valid hostname/i);
  });

  it('executeDeployApp passes custom_domain through to pendingAction.args for single-service deploy', async () => {
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'redis.example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.customDomain).toBe('redis.example.com');
      expect(r.pendingAction.args.customDomainServiceName).toBe('');
    }
  });

  it('executeDeployApp rejects multi-service stack without service_name', async () => {
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const services = JSON.stringify({
      web: { image: 'nginx', port: '80' },
      db: { image: 'postgres', port: '5432' },
    });
    const r = await executeDeployApp(
      { app_name: 'stack', services, custom_domain: 'app.example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/multi-service stack.*service_name/i);
      expect(r.error).toMatch(/web/);
      expect(r.error).toMatch(/db/);
    }
  });

  it('executeDeployApp accepts service_name when matching a stack service', async () => {
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const services = JSON.stringify({
      web: { image: 'nginx', port: '80' },
      db: { image: 'postgres', port: '5432' },
    });
    const r = await executeDeployApp(
      { app_name: 'stack', services, custom_domain: 'app.example.com', service_name: 'web' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.customDomain).toBe('app.example.com');
      expect(r.pendingAction.args.customDomainServiceName).toBe('web');
    }
  });

  it('executeDeployApp rejects unknown service_name in stack', async () => {
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const services = JSON.stringify({
      web: { image: 'nginx', port: '80' },
    });
    // Single-service stack auto-selects, so use multi-service to trigger the not-found path
    const services2 = JSON.stringify({
      web: { image: 'nginx', port: '80' },
      db: { image: 'postgres', port: '5432' },
    });
    const r = await executeDeployApp(
      { app_name: 'stack', services: services2, custom_domain: 'app.example.com', service_name: 'bogus' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/not found/i);
    void services;
  });

  it('executeDeployApp threads apex warning into customDomainWarning', async () => {
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(typeof r.pendingAction.args.customDomainWarning).toBe('string');
      expect(r.pendingAction.args.customDomainWarning).toMatch(/apex/i);
    }
  });

  // Hero (red → green) for PR #93 Copilot 3248436488: pre-fix code never
  // queries leaseByCustomDomain on the deploy path, so a duplicate domain
  // slips through and the deploy confirmation proceeds, charging for a
  // non-functional lease. Post-fix: pre-confirmation rejection.
  it('rejects deploy when the custom domain is already attached to another lease', async () => {
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValueOnce({
      lease: { uuid: 'lease-occupied' } as any,
      leaseUuid: 'lease-occupied',
      serviceName: '',
    });
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'taken.example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/already attached/i);
      expect(r.error).toMatch(/taken\.example\.com/);
    }
  });

  it('names the holding app in the error when the local registry knows it', async () => {
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValueOnce({
      lease: { uuid: 'lease-X' } as any,
      leaseUuid: 'lease-X',
      serviceName: '',
    });
    // Seed the registry so getAppByLease('lease-X') returns 'web-prod'.
    const registry = makeRegistry([{
      name: 'web-prod',
      leaseUuid: 'lease-X',
      size: 'micro',
      providerUuid: 'p1',
      providerUrl: 'https://fred.example.com',
      createdAt: 0,
      status: 'running',
    }]);
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'taken.example.com' },
      makeOptions({ appRegistry: registry }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/"web-prod"/);   // friendly: names the app
      expect(r.error).not.toMatch(/another lease/);
    }
  });

  // No-regression: queryLeaseByCustomDomain returns null → existing happy
  // path. customDomain MUST still land in pendingAction.args.
  it('does not block deploy when the domain is unattached on the chain', async () => {
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValueOnce(null);
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'fresh.example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(true);
    if (r.success && r.requiresConfirmation) {
      expect(r.pendingAction.args.customDomain).toBe('fresh.example.com');
    }
  });

  // No-regression: chain query throws → fallback to "don't block", chain
  // remains authoritative. Matches the existing set_custom_domain pattern.
  it('does not block deploy when queryLeaseByCustomDomain throws (chain authoritative)', async () => {
    vi.mocked(queryLeaseByCustomDomain).mockRejectedValueOnce(new Error('LCD timeout'));
    vi.mocked(getCreditEstimate).mockResolvedValue({
      estimatedDurationSeconds: 86400n,
      currentBalance: [],
      totalRatePerSecond: [],
      activeLeaseCount: 0n,
    } as any);
    const r = await executeDeployApp(
      { app_name: 'redis', image: 'redis', port: '6379', custom_domain: 'maybe-fresh.example.com' },
      makeOptions({ appRegistry: makeRegistry() }),
    );
    expect(r.success).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      'compositeTransactions.executeDeployApp.queryLeaseByCustomDomain',
      expect.any(Error),
    );
  });
});

describe('buildFredAuthCtx', () => {
  it('wires query=readClient.query, chain=clientManager, providerAuth=signing.providerAuth', async () => {
    const providerAuth = {
      providerToken: vi.fn(),
      leaseDataToken: vi.fn(),
    };
    const signing = {
      providerAuth,
      authTokens: { getAuthToken: vi.fn(), getLeaseDataAuthToken: vi.fn() },
      withSign: <T,>(fn: () => Promise<T>) => fn(),
    } as any;
    const ctx = await buildFredAuthCtx(CLIENT_MANAGER, signing);
    expect(ctx.query).toEqual({ __tag: 'read-query-client' });
    expect(ctx.chain).toBe(CLIENT_MANAGER);
    expect(ctx.providerAuth).toBe(providerAuth);
    expect(typeof ctx.fetch).toBe('function');
    expect(ctx.logger).toBeDefined();
  });
});

describe('classifyLeaseChainState', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACTIVE → running', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    expect(await classifyLeaseChainState('u')).toBe('running');
  });

  it('CLOSED/REJECTED/EXPIRED → failed', async () => {
    for (const s of [LeaseState.LEASE_STATE_CLOSED, LeaseState.LEASE_STATE_REJECTED, LeaseState.LEASE_STATE_EXPIRED]) {
      vi.mocked(getLease).mockResolvedValue({ state: s } as any);
      expect(await classifyLeaseChainState('u')).toBe('failed');
    }
  });

  it('PENDING / unspecified → deploying', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_PENDING } as any);
    expect(await classifyLeaseChainState('u')).toBe('deploying');
  });

  it('null lease (unavailable) → failed (trim correctness fix)', async () => {
    vi.mocked(getLease).mockResolvedValue(null as any);
    expect(await classifyLeaseChainState('u')).toBe('failed');
  });

  it('getLease throw → failed, never throws', async () => {
    vi.mocked(getLease).mockRejectedValue(new Error('rpc down'));
    expect(await classifyLeaseChainState('u')).toBe('failed');
  });
});

describe('handleDeployManifestError', () => {
  beforeEach(() => vi.clearAllMocks());

  function ctx(overrides: Record<string, unknown> = {}) {
    return {
      name: 'test-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://fred.example.com',
      address: ADDRESS,
      signing: makeOptions().signing!,
      appRegistry: makeRegistry([{ name: 'test-app', leaseUuid: 'lease-1', size: 'small', providerUuid: 'p1', providerUrl: 'x', createdAt: 0, status: 'deploying' } as AppEntry]),
      onProgress: vi.fn(),
      ...overrides,
    } as any;
  }

  it('case 1: raw Error (no lease) surfaces the raw message, no failure-log fetch', async () => {
    const c = ctx({ leaseUuid: undefined, providerUrl: undefined });
    const result = await handleDeployManifestError(new Error('insufficient funds'), c);
    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient funds');
    expect(getLeaseProvision).not.toHaveBeenCalled();
    expect(getLeaseLogs).not.toHaveBeenCalled();
    expect(c.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }));
  });

  it('case 3: TerminalChainStateError → updateApp(failed), no chain-check', async () => {
    const c = ctx();
    // Real TerminalChainStateError ctor is (leaseUuid, chainState, ctx?); the mock's
    // 1-arg ctor uses only the first arg as the message. Second arg satisfies the type.
    const result = await handleDeployManifestError(new TerminalChainStateError('lease rejected', 'rejected'), c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('lease rejected');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, 'lease-1', { status: 'failed' });
    expect(getLease).not.toHaveBeenCalled();
  });

  it('case 2 running: chain ACTIVE → running + ready progress (not failed)', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    const c = ctx();
    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll timeout', { partial: true }), c);
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, 'lease-1', { status: 'running' });
    expect(c.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
  });

  it('case 2 deploying: chain PENDING → non-failed still-provisioning result', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_PENDING } as any);
    const c = ctx();
    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll timeout', { partial: true }), c);
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('deploying');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, 'lease-1', { status: 'deploying' });
  });

  it('case 2 failed: chain terminal → failed + fetchFailureLogs + barney copy', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_CLOSED } as any);
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 2, last_error: 'OOMKilled' } as any);
    vi.mocked(getLeaseLogs).mockResolvedValue({ lease_uuid: 'lease-1', tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as any);
    const c = ctx();
    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'provision failed', { partial: true }), c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Deployment failed: provision failed');
    expect(result.error).toContain('OOMKilled');
    expect(result.error).not.toContain('close_lease');
  });

  it('case 2 failed: OPERATION_CANCELLED skips fetchFailureLogs', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_CLOSED } as any);
    const c = ctx();
    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.OPERATION_CANCELLED, 'aborted', { partial: true }), c);
    expect(result.success).toBe(false);
    expect(getLeaseProvision).not.toHaveBeenCalled();
    expect(getLeaseLogs).not.toHaveBeenCalled();
  });
});
