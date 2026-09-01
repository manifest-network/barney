import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatConnectionUrl, extractPrimaryServicePorts, deriveUrlFromConnection } from './helpers';
import {
  deriveAppName,
  extractUrlFromFredStatus,
  extractServiceNamesFromPayload,
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
import type { CosmosClientManager, DeployResult } from '@manifest-network/manifest-sdk';
import type { AppEntry } from '../../registry/appRegistry';
import { makeRegistry } from './testHelpers';
import { LeaseState } from '../../api/billing';
import { AI_DEPLOY_PROVISION_TIMEOUT_MS, AI_LEASE_WAIT_TIMEOUT_MS } from '../../config/constants';
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
  getLeaseLogs: vi.fn(),
  getLeaseProvision: vi.fn(),
  restartLease: vi.fn(),
  updateLease: vi.fn(),
}));

vi.mock('@manifest-network/manifest-sdk/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/chain')>()),
  cosmosTx: vi.fn(),
}));

// ENG-483: deployManifest + TerminalChainStateError are imported from the SDK
// deploy facade, so mock there. Spread the original facade; manifest.ts's
// buildManifest/mergeManifest/metaHashHex re-exports come from -fred (unmocked, real).
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal()),
  deployManifest: vi.fn(),
  stopApp: vi.fn(),
  setItemCustomDomain: vi.fn(),
  waitForLeaseStatus: vi.fn(),
  isLeaseFailureTerminal: vi.fn(),
  restartApp: vi.fn(),
  updateApp: vi.fn(),
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
import { getLeaseLogs, getLeaseProvision, restartLease, updateLease } from '../../api/fred';
import { cosmosTx } from '@manifest-network/manifest-sdk/chain';
import { setItemCustomDomain } from '@manifest-network/manifest-sdk/deploy';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-sdk';
import { TerminalChainStateError, deployManifest, stopApp, waitForLeaseStatus, isLeaseFailureTerminal, restartApp, updateApp, FRED_REASON_GUIDANCE } from '@manifest-network/manifest-sdk/deploy';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import { getReadClient } from '../../api/readClient';

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
      relayAuth: { signChallenge: vi.fn() },
    },
    tiers: SAMPLE_TIERS,
    ...overrides,
  };
}

function makePayload(): PayloadAttachment {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    filename: 'docker-compose.json',
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
function makeJsonPayload(filename = 'docker-compose.json'): PayloadAttachment {
  const json = JSON.stringify({ image: 'nginx', ports: { '80/tcp': {} } });
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

  it('returns a friendly error when image is a non-string (PR#114 hardening)', async () => {
    // A malformed model call with a numeric image would otherwise reach
    // findKnownImage(...).replace and throw a raw TypeError.
    const result = await executeDeployApp({ image: 12345 as unknown as string }, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/image must be a non-empty string/i);
  });

  it('returns error without wallet', async () => {
    const result = await executeDeployApp({}, makeOptions({ address: undefined }), makePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wallet not connected');
  });

  it('prepares a coalesced draft without repeating network-backed consent checks', async () => {
    const result = await executeDeployApp({
      image: 'redis:8',
      size: 'micro',
      custom_domain: 'redis.example.com',
    }, makeOptions({ prepareBatchDeployDraft: true }));

    expect(result).toMatchObject({
      success: true,
      requiresConfirmation: true,
      pendingAction: {
        toolName: 'deploy_app',
        args: {
          _batchDeployDraft: true,
          size: 'micro',
          customDomain: 'redis.example.com',
        },
      },
    });
    expect(getProviders).not.toHaveBeenCalled();
    expect(getCreditAccount).not.toHaveBeenCalled();
    expect(queryLeaseByCustomDomain).not.toHaveBeenCalled();
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

  // --- S3: env-name blocklist on file-uploaded manifests ---

  function makeManifestFile(obj: unknown, filename = 'manifest.json'): PayloadAttachment {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    return { bytes, filename, size: bytes.length, hash: 'c'.repeat(64) };
  }

  it('S3: rejects a file-attached single-service manifest with a blocked env name', async () => {
    const payload = makeManifestFile({ image: 'redis:8', env: { DOCKER_HOST: 'tcp://evil:2375' } });
    const result = await executeDeployApp({}, makeOptions(), payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked env variable(s): DOCKER_HOST');
  });

  it('S3: rejects a file-attached stack manifest with a blocked env name, naming the service', async () => {
    const payload = makeManifestFile({
      services: { web: { image: 'nginx', env: { KUBECONFIG: '/x' } } },
    });
    const result = await executeDeployApp({}, makeOptions(), payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Service "web"');
    expect(result.error).toContain('KUBECONFIG');
  });

  it('S3 regression: a clean file-attached manifest with allowed env still returns confirmation', async () => {
    vi.mocked(getSKUs).mockResolvedValue([
      { uuid: 'sku-1', name: 'docker-micro', providerUuid: 'p1' } as any,
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

    const payload = makeManifestFile({ image: 'redis:8', env: { MY_APP_VAR: 'ok' } });
    const result = await executeDeployApp({}, makeOptions(), payload);
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
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
    expect(result.error).toBe('Manifest must be valid JSON — convert YAML/other formats to JSON first.');
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
    expect(result.error).toBe('Manifest must be valid JSON — convert YAML/other formats to JSON first.');
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
  function mockDeploySuccess(result: Partial<import('@manifest-network/manifest-sdk').DeployResult>) {
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

  it('blocks an A to B switch after async setup and immediately before deploy', async () => {
    let resolveReadClient!: (client: Awaited<ReturnType<typeof getReadClient>>) => void;
    vi.mocked(getReadClient).mockImplementationOnce(
      () => new Promise((resolve) => { resolveReadClient = resolve; }),
    );
    let activeAddress = ADDRESS;
    const deploying = executeConfirmedDeployApp(
      ARGS,
      CLIENT_MANAGER,
      makeOptions({
        assertAuthorization: () => {
          if (activeAddress !== ADDRESS) throw new Error('wallet changed');
        },
      }),
      makePayload(),
    );
    await vi.waitFor(() => expect(getReadClient).toHaveBeenCalledOnce());

    activeAddress = 'manifest1walletb';
    resolveReadClient(
      { query: { __tag: 'read-query-client' } } as unknown as Awaited<ReturnType<typeof getReadClient>>,
    );

    await expect(deploying).rejects.toThrow('wallet changed');
    expect(deployManifest).not.toHaveBeenCalled();
  });

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
    expect(waitForLeaseStatus).not.toHaveBeenCalled();
    expect(setItemCustomDomain).not.toHaveBeenCalled();
    // registry addApp(deploying) fired in onLeaseCreated, then updateApp(running)
    expect(registry.addApp).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ status: 'deploying', leaseUuid: 'new-lease-uuid' }));
    // deployManifest only RESOLVES on chain-ACTIVE + provision_status 'ready',
    // so BOTH observations are first-hand; `status` is derived from them.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', expect.objectContaining({ chainState: 'active', provisionState: 'confirmed', url: '127.0.0.1:32456' }));
    expect(registry.getAppByLease(ADDRESS, 'new-lease-uuid')?.status).toBe('running');
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

  it('gives the readiness poll fred\'s own provisioning budget, not a shorter one (W6)', async () => {
    // fred v0.13.0 internal/backend/docker/config.go: ImagePullTimeout 5m,
    // ProvisionTimeout 10m. A deadline under 10m gives up while the provider is
    // still legitimately working, and the SDK then reports readiness as never
    // confirmed — the highest-frequency producer of a "deploying, we never found
    // out" outcome. The SDK's own DEFAULT_POLL_TIMEOUT_MS is 600000 for this reason.
    mockDeploySuccess({ connection: { host: '127.0.0.1', ports: { '80/tcp': { host_port: 1 } } } });
    await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions(), makePayload());

    const [, , callOptions] = vi.mocked(deployManifest).mock.calls[0];
    expect(callOptions?.pollOptions).not.toBe(false);
    const timeoutMs = (callOptions?.pollOptions as { timeoutMs?: number } | undefined)?.timeoutMs;
    expect(timeoutMs === undefined || timeoutMs >= 600_000).toBe(true);
    expect(AI_DEPLOY_PROVISION_TIMEOUT_MS).toBe(600_000);
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
    // C1: the running-on-throw branch resolves url/connection from the provider
    // so the app shows a link instead of a bare running status.
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '5.6.7.8', ports: { '80/tcp': { host_port: 32456 } } },
    } as any);
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry }), makePayload());
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBe('5.6.7.8:32456');
    // The 2d chain-truth arm observed the CHAIN only — no provider readiness
    // verdict was ever given — so it records `chainState` and nothing else.
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, 'new-lease-uuid',
      expect.objectContaining({ chainState: 'active', url: '5.6.7.8:32456', connection: expect.objectContaining({ host: '5.6.7.8' }) }),
    );
    expect(registry.getAppByLease(ADDRESS, 'new-lease-uuid')?.provisionState).toBeUndefined();
  });

  // W5 end-to-end: the readiness-unconfirmed arm of handleDeployManifestError
  // reached through the real deploy path. The branch itself is unit-tested in
  // deployError.test.ts; this pins that a real deployManifest throw routes into
  // it and that nothing downstream re-dresses it as a live app.
  it('reports a deploy whose readiness was never confirmed as still deploying, not as live', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      throw new ManifestMCPError(
        ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED,
        'Deploy partially succeeded: lease new-lease-uuid was created but its readiness could not be confirmed. ' +
          'Re-check with app_status({ lease_uuid: "new-lease-uuid" }), or keep waiting with wait_for_app_ready(…). ' +
          'Close this lease with close_lease ONLY if the provider reports a failed provision_status.',
        { partial: true, readiness_unconfirmed: true, poll_reason: 'deadline', failedStep: 'poll', lease_uuid: 'new-lease-uuid' },
      );
    });
    // ACTIVE is what the chain says for the whole provisioning window — the
    // reason the chain verdict cannot be the discriminant here.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    const registry = makeRegistry();

    const result = await executeConfirmedDeployApp(ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry }), makePayload());

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('deploying');
    expect((result.data as any).url).toBeUndefined();
    expect(result.success && !result.requiresConfirmation && result.displayCard).toBeUndefined();
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', { provisionState: 'unconfirmed' });
    // and the OBSERVATION is what survives: the derived summary is 'deploying',
    // and a later chain-only reconcile can no longer promote it to 'running'.
    expect(registry.getAppByLease(ADDRESS, 'new-lease-uuid')?.status).toBe('deploying');
    const message = (result.data as any).message as string;
    expect(message).not.toContain('is live');
    expect(message).toContain('we never found out');
    expect(message).not.toContain('close_lease');
    expect(message).not.toContain('wait_for_app_ready');
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

  it('closes lease and updates registry (single, blocking)', async () => {
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as any);

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedStopApp(
      { app_name: 'my-app', leaseUuid: app.leaseUuid },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('stopped');
    // CHAIN observation only — stopping says nothing about provisioning.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('stopped');
    // single path blocks on confirmation
    expect(stopApp).toHaveBeenCalledWith(
      expect.anything(),
      { leaseUuid: app.leaseUuid },
      { waitForConfirmation: true }
    );
  });

  it('stops multiple apps in bulk (async, non-blocking) and returns summary', async () => {
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as any);

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
    expect(stopApp).toHaveBeenCalledTimes(2);
    // bulk path fires async (no block-inclusion wait)
    expect(stopApp).toHaveBeenNthCalledWith(1, expect.anything(), { leaseUuid: 'uuid-1' }, { waitForConfirmation: false });
    expect(stopApp).toHaveBeenNthCalledWith(2, expect.anything(), { leaseUuid: 'uuid-2' }, { waitForConfirmation: false });
  });

  it('handles partial failures in bulk stop', async () => {
    vi.mocked(stopApp)
      .mockResolvedValueOnce({ outcome: 'stopped' } as any)
      .mockRejectedValueOnce(new Error('some error'));

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

  it('preserves completed stops when authorization changes between bulk entries', async () => {
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as any);
    const assertAuthorization = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('wallet changed'); });
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];

    const result = await executeConfirmedStopApp(
      { entries: apps.map((app) => ({ app_name: app.name, leaseUuid: app.leaseUuid })) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps), assertAuthorization }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      stopped: ['redis'],
      cancelled: ['postgres'],
      unconfirmed: [],
    });
    expect(stopApp).toHaveBeenCalledOnce();
  });

  it('does not submit any bulk stop after the live guard aborts the signal', async () => {
    const controller = new AbortController();
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as never);
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];

    const result = await executeConfirmedStopApp(
      { entries: apps.map((app) => ({ app_name: app.name, leaseUuid: app.leaseUuid })) },
      CLIENT_MANAGER,
      makeOptions({
        appRegistry: makeRegistry(apps),
        signal: controller.signal,
        assertAuthorization: () => controller.abort(),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not submitted: redis, postgres');
    expect(stopApp).not.toHaveBeenCalled();
  });

  it('reports the current bulk stop as unconfirmed when cancellation wins after broadcast', async () => {
    vi.mocked(stopApp)
      .mockResolvedValueOnce({ outcome: 'stopped' } as any)
      .mockRejectedValueOnce(new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'the broadcast may still commit',
        { sent: true },
      ));
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
      makeApp({ name: 'nginx', leaseUuid: 'uuid-3' }),
    ];

    const result = await executeConfirmedStopApp(
      { entries: apps.map((app) => ({ app_name: app.name, leaseUuid: app.leaseUuid })) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps) }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      stopped: ['redis'],
      unconfirmed: ['postgres'],
      cancelled: ['nginx'],
    });
    expect((result.data as { message: string }).message).toContain('check on-chain status before retrying');
    expect(stopApp).toHaveBeenCalledTimes(2);
  });

  it('reports current and remaining bulk stops as not submitted when cancellation is pre-broadcast', async () => {
    vi.mocked(stopApp)
      .mockResolvedValueOnce({ outcome: 'stopped' } as any)
      .mockRejectedValueOnce(new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'no transaction was sent',
        { sent: false },
      ));
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
      makeApp({ name: 'nginx', leaseUuid: 'uuid-3' }),
    ];

    const result = await executeConfirmedStopApp(
      { entries: apps.map((app) => ({ app_name: app.name, leaseUuid: app.leaseUuid })) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps) }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      stopped: ['redis'],
      unconfirmed: [],
      cancelled: ['postgres', 'nginx'],
    });
    expect((result.data as { message: string }).message).toContain('Not submitted: postgres, nginx');
    expect(stopApp).toHaveBeenCalledTimes(2);
  });

  it('reports a plain pre-broadcast AbortError and all remaining bulk stops as not submitted', async () => {
    vi.mocked(stopApp).mockRejectedValueOnce(
      new DOMException('This operation was aborted', 'AbortError'),
    );
    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2' }),
    ];

    const result = await executeConfirmedStopApp(
      { entries: apps.map((app) => ({ app_name: app.name, leaseUuid: app.leaseUuid })) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps) }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not submitted: redis, postgres');
    expect(result.error).not.toContain('Failed to stop');
    expect(stopApp).toHaveBeenCalledOnce();
  });

  it('treats an already-inactive lease as success (single)', async () => {
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'already_inactive' } as any);

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1' })];
    const registry = makeRegistry(apps);

    const result = await executeConfirmedStopApp(
      { app_name: 'redis', leaseUuid: 'uuid-1' },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    expect((result.data as any).message).toContain('already inactive');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'uuid-1', { chainState: 'absent' });
  });

  it('returns failure when all bulk stops fail', async () => {
    vi.mocked(stopApp).mockRejectedValue(new Error('error'));

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
      CLIENT_MANAGER,
      makeOptions(),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).amount).toBe(50);
  });

  it('does not broadcast when the pending target belongs to another wallet', async () => {
    const result = await executeConfirmedFundCredits(
      { amount: 50, denomString: '50000000upwr', address: 'manifest1walleta' },
      CLIENT_MANAGER,
      makeOptions({ address: 'manifest1walletb' }),
    );

    expect(result.success).toBe(false);
    expect(cosmosTx).not.toHaveBeenCalled();
  });

  it('runs the live authorization guard immediately before broadcast', async () => {
    await expect(executeConfirmedFundCredits(
      { amount: 50, denomString: '50000000upwr', address: ADDRESS },
      CLIENT_MANAGER,
      makeOptions({ assertAuthorization: () => { throw new Error('identity changed'); } }),
    )).rejects.toThrow('identity changed');

    expect(cosmosTx).not.toHaveBeenCalled();
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
    expect(result.pendingAction?.args.address).toBe(ADDRESS);
  });
});

describe('executeConfirmedCosmosTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes transaction', async () => {
    vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as any);

    const result = await executeConfirmedCosmosTx(
      { module: 'bank', subcommand: 'send', parsedArgs: ['addr', '100umfx'] },
      CLIENT_MANAGER,
      makeOptions(),
    );

    expect(result.success).toBe(true);
    expect(cosmosTx).toHaveBeenCalledWith(CLIENT_MANAGER, 'bank', 'send', ['addr', '100umfx'], true);
  });
});

// ============================================================================
// Batch deploy tests
// ============================================================================

function makeBatchEntry(name: string): BatchDeployEntry {
  const bytes = new TextEncoder().encode(JSON.stringify({ image: `${name}:latest`, ports: { '8080/tcp': {} } }));
  return {
    app_name: name,
    payload: {
      bytes,
      filename: `manifest-${name}.json`,
      size: bytes.length,
      hash: 'a'.repeat(64),
    },
  };
}

function mockLiveBatchCatalog(tiers = SAMPLE_TIERS): void {
  vi.mocked(getSKUs).mockResolvedValue(tiers.map((tier) => ({
    uuid: tier.skuUuid,
    name: tier.skuName,
    providerUuid: tier.providerUuid,
    basePrice: {
      amount: String(Math.round(tier.pricePerHour * 1_000_000)),
      denom: 'upwr',
    },
    unit: Unit.UNIT_PER_HOUR,
  } as any)));
  vi.mocked(getProviders).mockResolvedValue([
    { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
  ]);
  vi.mocked(getCreditAccount).mockResolvedValue({
    balances: [{ denom: 'upwr', amount: '1000000000' }],
  } as any);
}

async function confirmedBatchArgs(
  entries: BatchDeployEntry[],
  options: ToolExecutorOptions = makeOptions(),
): Promise<Record<string, unknown>> {
  const validEntries = entries.map((entry) => {
    try {
      JSON.parse(new TextDecoder().decode(entry.payload.bytes));
      return entry;
    } catch {
      return { ...entry, payload: makeJsonPayload(entry.payload.filename) };
    }
  });
  const result = await executeBatchDeploy(validEntries, options);
  if (!result.requiresConfirmation) {
    throw new Error(result.success ? 'Expected batch confirmation' : result.error);
  }
  return result.pendingAction.args;
}

describe('executeBatchDeploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveBatchCatalog();
  });

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
    const result = await executeBatchDeploy([makeBatchEntry('app1')], makeOptions(), 'xxlarge');
    expect(result.success).toBe(true);
    const entries = (result.pendingAction?.args.plan as {
      entries: Array<{ size: string; requestedSize?: string }>;
    }).entries;
    expect(entries[0].size).toBe('docker-micro'); // SAMPLE_TIERS cheapest
    expect(entries[0].requestedSize).toBe('xxlarge');
  });

  it('batch defaults to the cheapest resolved tier when size is omitted', async () => {
    vi.mocked(getProviders).mockResolvedValue([
      { uuid: 'p1', apiUrl: 'https://fred.example.com', active: true } as any,
    ]);

    // Arrange so the cheapest tier (docker-small @ 0.01 PWR/hr) is NOT tiers[0].
    // A `tiers[0]`-based regression would silently pass against SAMPLE_TIERS;
    // this ordering forces the test to rely on price comparison.
    const tiersOutOfPriceOrder = [
      { skuName: 'docker-large', skuUuid: 'sku-l', providerUuid: 'p1', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-small', skuUuid: 'sku-s', providerUuid: 'p1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.01, denomSymbol: 'PWR', unit: 1 },
      { skuName: 'docker-micro', skuUuid: 'sku-mi', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
    ];
    mockLiveBatchCatalog(tiersOutOfPriceOrder);

    const result = await executeBatchDeploy(
      [makeBatchEntry('app1')],
      makeOptions({ tiers: tiersOutOfPriceOrder }),
    );

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    const entries = (result.pendingAction?.args.plan as { entries: Array<{ size: string }> }).entries;
    expect(entries[0].size).toBe('docker-small');
  });

  it('returns confirmation for valid batch', async () => {
    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2')];
    const result = await executeBatchDeploy(entries, makeOptions());

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationMessage).toContain('2 apps');
    expect(result.confirmationMessage).toContain('app1');
    expect(result.confirmationMessage).toContain('app2');
    expect(result.pendingAction?.toolName).toBe('batch_deploy');
    expect((result.pendingAction?.args.plan as { entries: unknown[] }).entries).toHaveLength(2);
  });

  // Pass-16 batch-side regression catchers. Mirrors the single-deploy pair
  // above. Pre-fix, the batch `confirmationMessage` template
  // `... tier${priceDisplay ? ` (~${priceDisplay} each)` : ''}?` dropped the
  // price wrapper entirely when priceDisplay was empty — and priceDisplay
  // was empty whenever pricePerHour was 0 (the pass-11-now-incorrect guard).
  it('renders "0.0000 .../hr" on the batch confirmation message for a free tier (pass-16)', async () => {
    const freeTier = [
      { skuName: 'docker-micro', skuUuid: 'sku-free', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0, denomSymbol: 'PWR', unit: 1 },
    ];
    mockLiveBatchCatalog(freeTier);
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
    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2')];
    const result = await executeBatchDeploy(entries, makeOptions());

    expect(result.success).toBe(true);
    // Two one-service apps at 0.036 PWR/hr each are disclosed as the aggregate.
    expect(result.confirmationMessage).toContain('0.0720 PWR/hr total');
  });

  it('returns insufficient credits error when total cost exceeds balance', async () => {
    const tiersWithHighPrice = SAMPLE_TIERS.map(t => ({ ...t, pricePerHour: 1.0 }));
    mockLiveBatchCatalog(tiersWithHighPrice);
    // 0.5 PWR balance with tier price 1 PWR/hour × 3 entries = need 3, have 0.5
    vi.mocked(getCreditAccount).mockResolvedValue({
      balances: [{ denom: 'upwr', amount: '500000' }],
    } as any);

    const entries = [makeBatchEntry('app1'), makeBatchEntry('app2'), makeBatchEntry('app3')];
    const result = await executeBatchDeploy(entries, makeOptions({ tiers: tiersWithHighPrice }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
  });

  it('rejects two apps that are individually affordable but collectively unaffordable', async () => {
    const oneCreditTier = SAMPLE_TIERS.map((tier) => ({ ...tier, pricePerHour: 1 }));
    mockLiveBatchCatalog(oneCreditTier);
    vi.mocked(getCreditAccount).mockResolvedValue({
      // Each 1 PWR/hr app is affordable on its own; the 2 PWR/hr batch is not.
      balances: [{ denom: 'upwr', amount: '1500000' }],
    } as any);

    const result = await executeBatchDeploy(
      [makeBatchEntry('alpha'), makeBatchEntry('beta')],
      makeOptions({ tiers: oneCreditTier }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
    expect(result.error).toContain('2.00 PWR');
  });

  it('stores a deeply frozen consent plan with exact manifest and plan hashes', async () => {
    const result = await executeBatchDeploy(
      [makeBatchEntry('alpha'), makeBatchEntry('beta')],
      makeOptions(),
    );

    expect(result.requiresConfirmation).toBe(true);
    if (!result.requiresConfirmation) throw new Error('expected confirmation');
    const plan = result.pendingAction.args.plan as any;
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.entries.map((entry: any) => entry.draftIndex)).toEqual([0, 1]);
    expect(plan.entries[0].manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.entries[0].manifest).toContain('alpha:latest');
    expect(plan.totalPricePerHour).toBeCloseTo(0.072);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entries)).toBe(true);
    expect(Object.isFrozen(plan.entries[0])).toBe(true);
    expect(Object.isFrozen(plan.entries[0].services)).toBe(true);
  });

  it('fails closed when aggregate balance cannot be verified', async () => {
    vi.mocked(getCreditAccount).mockResolvedValue(null as any);
    const result = await executeBatchDeploy([makeBatchEntry('alpha')], makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not verify aggregate credit balance');
  });

  it('extracts service names from stack manifest payloads', async () => {
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
    const resolvedEntries = (result.pendingAction?.args.plan as { entries: any[] }).entries;
    expect(resolvedEntries).toHaveLength(1);
    expect(resolvedEntries[0].serviceNames).toEqual(['web', 'db']);
  });

  it('checks independent custom domains in parallel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(queryLeaseByCustomDomain).mockImplementation(async () => {
      await gate;
      return null;
    });
    const planning = executeBatchDeploy([
      { ...makeBatchEntry('alpha'), customDomain: 'alpha.example.com' },
      { ...makeBatchEntry('beta'), customDomain: 'beta.example.com' },
    ], makeOptions());

    try {
      await vi.waitFor(() => expect(queryLeaseByCustomDomain).toHaveBeenCalledTimes(2));
    } finally {
      release();
    }
    const result = await planning;

    expect(result.success).toBe(true);
  });

  it('keeps valid coalesced drafts when one custom domain is already attached', async () => {
    vi.mocked(queryLeaseByCustomDomain).mockImplementation(async (domain) =>
      domain === 'cache.example.com' ? { leaseUuid: 'old-lease' } as any : null
    );
    const result = await executeBatchDeploy([
      { ...makeBatchEntry('redis'), draftIndex: 0, customDomain: 'cache.example.com' },
      { ...makeBatchEntry('nginx'), draftIndex: 1 },
      { ...makeBatchEntry('ghost'), draftIndex: 2 },
    ], makeOptions(), undefined, { allowPartialEntries: true });

    expect(result.requiresConfirmation).toBe(true);
    if (!result.requiresConfirmation) throw new Error('expected partial batch confirmation');
    expect(result.rejectedEntries).toEqual([{
      draftIndex: 0,
      error: expect.stringContaining('cache.example.com'),
    }]);
    const plan = result.pendingAction.args.plan as any;
    expect(plan.entries.map((entry: any) => entry.draftIndex)).toEqual([1, 2]);
    expect(plan.entries.map((entry: any) => entry.app_name)).toEqual(['nginx', 'ghost']);
    expect(getCreditAccount).toHaveBeenCalledOnce();
  });

  it('preserves actionable multi-service custom-domain validation errors', async () => {
    const stackManifest = JSON.stringify({
      services: {
        web: { image: 'wordpress:6' },
        db: { image: 'mysql:9' },
      },
    });
    const stackBytes = new TextEncoder().encode(stackManifest);
    const stackEntry: BatchDeployEntry = {
      app_name: 'wordpress',
      customDomain: 'wp.example.com',
      payload: {
        bytes: stackBytes,
        filename: 'wordpress.json',
        size: stackBytes.length,
        hash: 'b'.repeat(64),
      },
    };

    const missing = await executeBatchDeploy([stackEntry], makeOptions());
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/pass service_name.*web, db/i);

    const unknown = await executeBatchDeploy([
      { ...stackEntry, customDomainServiceName: 'api' },
    ], makeOptions());
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain('Service "api" not found in stack. Available: web, db.');
  });

  it('stops awaiting an in-flight custom-domain check when planning is aborted', async () => {
    const controller = new AbortController();
    vi.mocked(queryLeaseByCustomDomain).mockReturnValueOnce(new Promise<never>(() => {}));
    const planning = executeBatchDeploy([
      { ...makeBatchEntry('alpha'), customDomain: 'alpha.example.com' },
    ], makeOptions({ signal: controller.signal }));
    await vi.waitFor(() => expect(queryLeaseByCustomDomain).toHaveBeenCalledOnce());

    controller.abort();

    await expect(planning).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCreditAccount).not.toHaveBeenCalled();
  });

  it('counts services (not just entries) for credit check on stack deploys', async () => {
    const tiersWithHighPrice = SAMPLE_TIERS.map(t => ({ ...t, pricePerHour: 1.0 }));
    mockLiveBatchCatalog(tiersWithHighPrice);
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

    // 1 entry with 2 services → needs 2 credits, but only 1.5 available
    const result = await executeBatchDeploy([entry], makeOptions({ tiers: tiersWithHighPrice }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
    expect(result.error).toContain('2 services');
  });
});

describe('executeConfirmedBatchDeploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveBatchCatalog();
  });

  it('rejects a legacy/unplanned batch action', async () => {
    const result = await executeConfirmedBatchDeploy({ entries: [] }, CLIENT_MANAGER, makeOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid batch deployment plan');
  });

  it('rejects payload tampering before any deployment is submitted', async () => {
    const args = await confirmedBatchArgs([makeBatchEntry('alpha'), makeBatchEntry('beta')]);
    const plan = args.plan as any;
    const tampered = {
      ...plan,
      entries: plan.entries.map((entry: any, index: number) => index === 0
        ? { ...entry, manifest: entry.manifest.replace('alpha:latest', 'attacker:latest') }
        : entry),
    };

    const result = await executeConfirmedBatchDeploy(
      { plan: tampered },
      CLIENT_MANAGER,
      makeOptions(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('integrity check failed');
    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('hashes stable draft identities and rejects identity tampering before broadcast', async () => {
    const args = await confirmedBatchArgs([makeBatchEntry('alpha'), makeBatchEntry('beta')]);
    const plan = args.plan as any;
    const tampered = {
      ...plan,
      entries: plan.entries.map((entry: any, index: number) => index === 0
        ? { ...entry, draftIndex: 99 }
        : entry),
    };

    const result = await executeConfirmedBatchDeploy(
      { plan: tampered },
      CLIENT_MANAGER,
      makeOptions(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('integrity check failed');
    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('rejects a price change discovered immediately before execution', async () => {
    const args = await confirmedBatchArgs([makeBatchEntry('alpha'), makeBatchEntry('beta')]);
    mockLiveBatchCatalog(SAMPLE_TIERS.map((tier) => ({
      ...tier,
      pricePerHour: tier.pricePerHour + 0.01,
    })));

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, makeOptions());

    expect(getSKUs).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('plan changed after approval');
    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('builds the initial and confirmed plans from the same live catalog', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });
    const staleStoreTiers = SAMPLE_TIERS.map((tier) => ({
      ...tier,
      pricePerHour: tier.pricePerHour + 10,
    }));
    const options = makeOptions({ tiers: staleStoreTiers });

    const args = await confirmedBatchArgs([makeBatchEntry('alpha')], options);
    const plan = args.plan as { totalPricePerHour: number };
    expect(plan.totalPricePerHour).toBeCloseTo(SAMPLE_TIERS[0].pricePerHour);

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, options);

    expect(result.success).toBe(true);
    expect(getSKUs).toHaveBeenCalledTimes(2);
    expect(deployManifest).toHaveBeenCalledOnce();
  });

  it('hashes and sizes the canonical stored manifest when input has a UTF-8 BOM', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });
    const manifestBytes = new TextEncoder().encode('{"image":"bom:latest"}');
    const bytesWithBom = new Uint8Array(manifestBytes.length + 3);
    bytesWithBom.set([0xef, 0xbb, 0xbf]);
    bytesWithBom.set(manifestBytes, 3);
    const entry: BatchDeployEntry = {
      app_name: 'bom-app',
      payload: {
        bytes: bytesWithBom,
        filename: 'manifest-bom.json',
        size: bytesWithBom.length,
        hash: 'b'.repeat(64),
      },
    };

    const args = await confirmedBatchArgs([entry]);
    const plannedEntry = (args.plan as any).entries[0];
    expect(plannedEntry.manifest).toBe('{"image":"bom:latest"}');
    expect(plannedEntry.manifestSize).toBe(manifestBytes.length);

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, makeOptions());

    expect(result.success).toBe(true);
    expect(deployManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ manifest: '{"image":"bom:latest"}' }),
      expect.anything(),
    );
  });

  it('preserves an unavailable-size substitution across confirm-time replanning', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });
    const args = await confirmedBatchArgs([{
      ...makeBatchEntry('fallback-app'),
      size: 'xxlarge',
    }]);
    const plannedEntry = (args.plan as any).entries[0];
    expect(plannedEntry).toMatchObject({
      size: 'docker-micro',
      requestedSize: 'xxlarge',
    });

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, makeOptions());

    expect(result.success).toBe(true);
    expect(deployManifest).toHaveBeenCalledOnce();
  });

  it('recomputes aggregate balance immediately before execution', async () => {
    vi.mocked(getCreditAccount)
      .mockResolvedValueOnce({ balances: [{ denom: 'upwr', amount: '1000000000' }] } as any)
      .mockResolvedValueOnce({ balances: [{ denom: 'upwr', amount: '10000' }] } as any);
    const args = await confirmedBatchArgs([makeBatchEntry('alpha'), makeBatchEntry('beta')]);

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient credits');
    expect(getCreditAccount).toHaveBeenCalledTimes(2);
    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('stops confirm-time planning when the authorization guard fails', async () => {
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    await expect(executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries),
      CLIENT_MANAGER,
      makeOptions({ assertAuthorization: () => { throw new Error('wallet changed'); } }),
    )).rejects.toThrow('wallet changed');

    expect(deployManifest).not.toHaveBeenCalled();
  });

  it('stops confirm-time planning when the live guard aborts the signal', async () => {
    const controller = new AbortController();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    await expect(executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries),
      CLIENT_MANAGER,
      makeOptions({
        signal: controller.signal,
        assertAuthorization: () => controller.abort(),
      }),
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(deployManifest).not.toHaveBeenCalled();
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

    const result = await executeConfirmedBatchDeploy(await confirmedBatchArgs(entries, opts), CLIENT_MANAGER, opts);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.deployed).toHaveLength(2);
    expect(data.deployed.map((d: any) => d.name)).toEqual(expect.arrayContaining(['game1', 'game2']));
    expect(data.failed).toHaveLength(0);
    expect(deployManifest).toHaveBeenCalledTimes(2);
    // ENG-312 Phase 8: signing.withSign no longer exists — deployManifest holds
    // the broadcast lock internally, so the old "not wrapped in withSign"
    // deadlock guard is structurally impossible now.
    // Batch delegates domain attach to deployManifest — never a direct set call.
    expect(setItemCustomDomain).not.toHaveBeenCalled();
    const lastProgress = onProgress.mock.calls.at(-1)![0];
    expect(lastProgress.batch).toBeDefined();
  });

  it('broadcasts manifests and resolved SKUs semantically equivalent to the displayed plan', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });
    const args = await confirmedBatchArgs([
      makeBatchEntry('alpha'),
      { ...makeBatchEntry('beta'), size: 'docker-small' },
    ]);
    const displayedPlan = args.plan as any;

    const result = await executeConfirmedBatchDeploy(args, CLIENT_MANAGER, makeOptions());

    expect(result.success).toBe(true);
    const specs = vi.mocked(deployManifest).mock.calls.map((call) => call[1]);
    expect(specs.map((spec) => spec.manifest)).toEqual(
      expect.arrayContaining(displayedPlan.entries.map((entry: any) => entry.manifest)),
    );
    expect(specs.map((spec) => spec.sku)).toEqual(expect.arrayContaining(
      displayedPlan.entries.map((entry: any) => ({
        kind: 'resolved',
        skuUuid: entry.skuUuid,
        providerUuid: entry.providerUuid,
      })),
    ));
  });

  it('records the deployManifest-resolved providerUrl (onLeaseCreated arg), not the stale entry value', async () => {
    // Regression guard (Copilot PR #106): the registry must record the URL
    // deployManifest actually resolved (onLeaseCreated's 2nd arg), mirroring
    // single-deploy — NOT entry.providerUrl. Use a DISTINCT resolved URL so the
    // assertion fails if the code reverts to entry.providerUrl.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://resolved.example.com');
      return makeDeployResult();
    });
    const registry = makeRegistry();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://stale.example.com', payload: makePayload() },
    ];

    await executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries),
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
    );

    expect(registry.addApp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerUrl: 'https://resolved.example.com' }),
    );
  });

  it('batch failure fetches diagnostics from the deployManifest-resolved providerUrl, not the stale entry value', async () => {
    // Regression guard (Copilot PR #106): handleDeployManifestError's
    // fetchFailureLogs must use the providerUrl deployManifest actually
    // resolved (onLeaseCreated's 2nd arg), mirroring single-deploy — NOT
    // entry.providerUrl. Use a DISTINCT resolved URL so the assertion fails
    // if the code reverts to entry.providerUrl.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('lease-x', 'https://resolved.example.com');
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'provision failed', { partial: true });
    });
    // getLease → null so classifyLeaseChainState's verdict is 'failed', which
    // is what routes handleDeployManifestError into fetchFailureLogs.
    // *Once: these mocks are shared across describes and vi.clearAllMocks()
    // doesn't clear a configured resolved value — a persisting mockResolvedValue
    // here would leak into later describes (e.g. executeConfirmedUpdateApp's
    // rollback-detection getLeaseProvision call) that rely on the default
    // (unconfigured) mock behavior.
    vi.mocked(getLease).mockResolvedValueOnce(null as any);
    vi.mocked(getLeaseProvision).mockResolvedValueOnce({ status: 'failed', fail_count: 1, last_error: 'OOMKilled' } as any);
    vi.mocked(getLeaseLogs).mockResolvedValueOnce({ lease_uuid: 'lease-x', tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as any);

    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://stale.example.com', payload: makePayload() },
    ];

    await executeConfirmedBatchDeploy(await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions());

    expect(getLeaseProvision).toHaveBeenCalledWith('https://resolved.example.com', 'lease-x', expect.anything());
    expect(getLeaseProvision).not.toHaveBeenCalledWith('https://stale.example.com', 'lease-x', expect.anything());
  });

  // W5 twin of the fixture above, on the post-ENG-508 wire shape. Fred v0.13.0
  // deleted `last_error` from /provision, so the old `if (provision.last_error)`
  // is permanently false against a current provider — and when the container
  // never started there are no logs either, leaving a batch entry that reports
  // the failure with no cause at all.
  it('surfaces the post-ENG-508 provision reason/message in a failed batch entry', async () => {
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('lease-x', 'https://resolved.example.com');
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'provision failed', { partial: true });
    });
    vi.mocked(getLease).mockResolvedValueOnce(null as any);
    vi.mocked(getLeaseProvision).mockResolvedValueOnce({
      status: 'failed', fail_count: 2, reason: 'ImagePullFailed', message: 'pull access denied for ngnix',
    } as any);
    vi.mocked(getLeaseLogs).mockResolvedValueOnce({ lease_uuid: 'lease-x', tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as any);

    const onProgress = vi.fn();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    await executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries),
      CLIENT_MANAGER,
      makeOptions({ onProgress }),
    );

    // Batch per-app detail lands in onProgress's `batch` array, not the top-level detail.
    const details = onProgress.mock.calls
      .flatMap((c) => (c[0] as { batch?: Array<{ detail?: string }> }).batch ?? [])
      .map((b) => b.detail ?? '');
    expect(details.some((d) => d.includes('ImagePullFailed: pull access denied for ngnix'))).toBe(true);
    // The curated next step rides along — asserted against the real constant.
    expect(details.some((d) => d.includes(FRED_REASON_GUIDANCE.ImagePullFailed.nextStep))).toBe(true);
  });

  it('does not count a readiness-unconfirmed entry as deployed', async () => {
    // Batch seam of the bug W5 fixed for the single path. handleDeployManifestError
    // answers success:true for the readiness-unconfirmed arm — correctly, it is
    // NOT a failure — but a boolean success/failure split put it in `succeeded`,
    // so the summary said "All 2 apps deployed!" about an app the provider never
    // confirmed, while that row's progress phase read 'failed'.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      const spec = _spec as any;
      if (String(spec.manifest).includes('unconfirmed')) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED,
          'readiness could not be confirmed',
          { partial: true, readiness_unconfirmed: true, poll_reason: 'deadline', failedStep: 'poll' },
        );
      }
      return makeDeployResult();
    });
    // ACTIVE for the whole provisioning window — the reason the chain verdict
    // cannot be the discriminant here.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);

    const okPayload = makePayload();
    const unconfirmedBytes = new TextEncoder().encode('{"image":"unconfirmed"}');
    const onProgress = vi.fn();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: okPayload },
      { app_name: 'postgres', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com',
        payload: { ...okPayload, bytes: unconfirmedBytes, size: unconfirmedBytes.length } },
    ];

    const result = await executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions({ appRegistry: makeRegistry(), onProgress })
    );

    const data = result.data as any;
    expect(data.deployed.map((d: any) => d.name)).toEqual(['game1']);
    expect(data.unconfirmed.map((u: any) => u.name)).toEqual(['postgres']);
    expect(data.failed).toHaveLength(0);
    expect(data.message).toContain('Still deploying');
    expect(data.message).toContain('postgres');
    // The exact claim the bug made.
    const lastProgress = onProgress.mock.calls.at(-1)![0];
    expect(lastProgress.detail).not.toContain('All 2 apps deployed!');
    expect(lastProgress.detail).toContain('1 still deploying');
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

    const result = await executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries),
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
    );

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
      await executeConfirmedBatchDeploy(await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect(spec.customDomain).toBe('a1.example.com');
      expect(spec.serviceName).toBeUndefined();
      expect(setItemCustomDomain).not.toHaveBeenCalled();
    });

    it('passes serviceName into the spec for a multi-service stack entry', async () => {
      mockDeploy();
      const stackBytes = new TextEncoder().encode(JSON.stringify({
        services: {
          web: { image: 'wordpress:latest', ports: { '80/tcp': {} } },
          db: { image: 'mysql:latest' },
        },
      }));
      const entries = [
        {
          app_name: 'wp',
          size: 'small',
          payload: { bytes: stackBytes, filename: 'wp.json', size: stackBytes.length, hash: 'ignored' },
          customDomain: 'wp.example.com',
          customDomainServiceName: 'web',
        },
      ];
      await executeConfirmedBatchDeploy(await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect(spec.customDomain).toBe('wp.example.com');
      expect(spec.serviceName).toBe('web');
    });

    it('omits customDomain and serviceName from the spec when the entry has none', async () => {
      mockDeploy();
      const entries = [
        { app_name: 'plain', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
      ];
      await executeConfirmedBatchDeploy(await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions());

      const spec = vi.mocked(deployManifest).mock.calls[0][1];
      expect('customDomain' in spec).toBe(false);
      expect('serviceName' in spec).toBe(false);
    });

    it('caches customDomains in the registry after a successful domain deploy', async () => {
      // Cache write is gated on the SDK RESULT (mirrors single-deploy), not the
      // request input — so the mock must echo the attach back on the result.
      vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
        await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
        return makeDeployResult({ custom_domain: 'cached.example.com', service_name: '' });
      });
      const reg = makeRegistry();
      const updateSpy = vi.spyOn(reg, 'updateApp');
      const entries = [
        { app_name: 'cached', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload(), customDomain: 'cached.example.com' },
      ];
      await executeConfirmedBatchDeploy(
        await confirmedBatchArgs(entries),
        CLIENT_MANAGER,
        makeOptions({ appRegistry: reg }),
      );

      const domainWrite = updateSpy.mock.calls.find((c) => Array.isArray((c[2] as any).customDomains));
      expect(domainWrite).toBeDefined();
      expect((domainWrite![2] as any).customDomains).toEqual([
        { serviceName: '', customDomain: 'cached.example.com' },
      ]);
    });

    it('lands a fatal in-deploy domain failure in failed[] (no non-fatal summary)', async () => {
      // deployManifest owns the attach; a rejection there is terminal — the entry
      // must land in failed[], never deployed[] as a non-fatal annotation.
      vi.mocked(deployManifest).mockRejectedValue(new Error('set-domain rejected'));
      const entries = [
        { app_name: 'rej', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload(), customDomain: 'rej.example.com' },
      ];
      const result = await executeConfirmedBatchDeploy(
        await confirmedBatchArgs(entries),
        CLIENT_MANAGER,
        makeOptions(),
      );

      expect(result.success).toBe(false); // all entries failed
      expect(result.error).toContain('rej');
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
  // clearAllMocks() keeps mockReturnValue across tests, so re-seed the default
  // (success terminal) each time; the poll-failure test overrides to true.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(false);
  });

  it('restarts app and polls to ready', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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
    expect(restartApp).toHaveBeenCalled();
    // The raw HTTP wrapper is no longer on this path (ENG-774): the primitive is.
    expect(restartLease).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'restarting' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
  });

  it('handles 409 error from restart endpoint', async () => {
    vi.mocked(restartApp).mockRejectedValue(new ProviderApiError(409, '{"error":"invalid state for restart","code":409}'));

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
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      last_error: 'container crashed',
    });
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(true);

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('container crashed');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
  });

  it('records unconfirmed — not failed — when the readiness wait rejects (timeout/error, no abort)', async () => {
    // ENG-312: waitForLeaseStatus REJECTS on timeout, so an observation still
    // has to be recorded here (the deleted waitForLeaseReady resolved instead
    // and fell through to the terminal branch). N4 changes WHICH observation:
    // a timeout is silence, not a verdict, so it is 'unconfirmed'. Verified
    // against the 0.21.0 pin — waitForLeaseStatus RESOLVES at every terminal
    // state, so a provider verdict never arrives as a rejection at all.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('deadline exceeded'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('may still be in progress');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'unconfirmed' });
    // The observation is still recorded (the anti-"stays running" guarantee the
    // original test existed for), it just derives 'deploying' rather than
    // asserting a failure verdict nobody gave.
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('deploying');
  });

  it('records failed when the wait rejection DOES carry a provider verdict (kind: poll_verdict)', async () => {
    // Defence-in-depth arm of provisionObservationFromWaitError: today only
    // pollLeaseReadiness stamps kind 'poll_verdict', but if a real verdict ever
    // surfaces as a rejection it must NOT be softened to 'unconfirmed'.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(
      new ProviderApiError(0, 'Lease is ACTIVE but provisioning failed: container exited', { kind: 'poll_verdict' })
    );

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('records unconfirmed for a NON-transient provider error too (retryability is the wrong axis)', async () => {
    // isTransientProviderError would answer false for a 401, but "worth
    // retrying" is orthogonal to "did the workload come up". Neither says the
    // provider gave a provisioning verdict, so both are 'unconfirmed'.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new ProviderApiError(401, 'unauthorized', { kind: 'http' }));

    const app = makeApp();
    const registry = makeRegistry([app]);
    await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'unconfirmed' });
  });

  it('does NOT mark the app failed when the wait is aborted (user interrupt)', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    // stronger than "no failed write": an abort observed NOTHING, so no
    // provisioning observation exists on the entry at all.
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
  });

  it('does NOT mark the app failed when the RESTART POST itself is aborted', async () => {
    // ENG-774 regression. Threading `signal` into restartApp added a throw site
    // barney never had: the primitive throwIfAborted()s after the token mint
    // (queued on the signing mutex) and BEFORE the non-idempotent POST. The app
    // was never restarted and is healthy — marking it 'failed' drops it out of
    // list_apps() and shows it failed in the sidebar. Twin of the wait-site
    // guard above, at the POST site.
    vi.mocked(restartApp).mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    // stronger than "no failed write": an abort observed NOTHING, so no
    // provisioning observation exists on the entry at all.
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
    expect(result.error).toContain('cancelled before the provider was asked');
    // Never the raw AbortError text dressed up as a restart failure.
    expect(result.error).not.toContain('This operation was aborted');
    expect(result.error).not.toContain('Restart failed');
  });

  it('restarts multiple apps in batch and returns summary', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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
    expect(restartApp).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'restart',
      batch: expect.arrayContaining([
        expect.objectContaining({ name: 'redis' }),
        expect.objectContaining({ name: 'postgres' }),
      ]),
    }));
  });

  it('buckets an authorization guard failure as cancelled before restart', async () => {
    const app = makeApp({ name: 'redis', leaseUuid: 'uuid-1' });

    const result = await executeConfirmedRestartApp(
      {
        app_name: 'all',
        entries: [{ app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl }],
      },
      CLIENT_MANAGER,
      makeOptions({
        appRegistry: makeRegistry([app]),
        assertAuthorization: () => { throw new Error('wallet changed'); },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cancelled: redis');
    expect(result.error).not.toContain('Failed: redis');
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('buckets a signal aborted by the live restart guard as cancelled before the POST', async () => {
    const controller = new AbortController();
    const app = makeApp({ name: 'redis', leaseUuid: 'uuid-1' });

    const result = await executeConfirmedRestartApp(
      {
        app_name: 'all',
        entries: [{ app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl }],
      },
      CLIENT_MANAGER,
      makeOptions({
        appRegistry: makeRegistry([app]),
        signal: controller.signal,
        assertAuthorization: () => controller.abort(),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cancelled: redis');
    expect(result.error).not.toContain('Failed: redis');
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('handles partial failures in batch restart', async () => {
    // First app succeeds, second fails with 409
    vi.mocked(restartApp)
      .mockResolvedValueOnce({ lease_uuid: 'uuid-1', status: 'restarting' })
      .mockRejectedValueOnce(new ProviderApiError(409, '{"error":"invalid state for restart","code":409}'));
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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

  it('calls the restartApp primitive on the fast path, with the abort signal', async () => {
    // ENG-774 / D6. `providerUrl` selects the primitive's fast path: without it
    // restartApp would run fetchActiveLease + resolveProviderUrl and add two
    // chain round-trips per restart. `pollOptions: false` keeps barney's own
    // waitForLeaseStatus + ProgressCard in charge. `signal` is what gives the
    // POST its throwIfAborted guard.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });

    const app = makeApp();
    const controller = new AbortController();
    await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry([app]), signal: controller.signal })
    );

    expect(restartApp).toHaveBeenCalledWith(
      expect.anything(),
      { address: ADDRESS, leaseUuid: app.leaseUuid },
      { pollOptions: false, providerUrl: app.providerUrl, signal: controller.signal }
    );
  });

  it('calls the restartApp primitive per entry on the bulk path, with the abort signal', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));
    const controller = new AbortController();

    await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps), signal: controller.signal })
    );

    // The registry providerUrl, per entry — not a resolved-from-chain one.
    expect(restartApp).toHaveBeenCalledWith(
      expect.anything(),
      { address: ADDRESS, leaseUuid: 'uuid-1' },
      { pollOptions: false, providerUrl: 'https://fred1.example.com', signal: controller.signal }
    );
    expect(restartApp).toHaveBeenCalledWith(
      expect.anything(),
      { address: ADDRESS, leaseUuid: 'uuid-2' },
      { pollOptions: false, providerUrl: 'https://fred2.example.com', signal: controller.signal }
    );
    expect(restartLease).not.toHaveBeenCalled();
  });

  it('never fires the restart POST for entries the batch never queued (aborted)', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));
    const controller = new AbortController();
    controller.abort();

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps), signal: controller.signal })
    );

    expect(restartApp).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('buckets an entry aborted AT the POST as cancelled, not failed (already queued)', async () => {
    // Distinct from the pre-queue short-circuit below: here the entry WAS
    // queued, executeOne ran, and the primitive's own throwIfAborted fired
    // before the POST. The app was never restarted, so it must not be marked
    // 'failed' nor counted in the batch's Failed list.
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });

    const controller = new AbortController();
    let call = 0;
    vi.mocked(restartApp).mockImplementation(async () => {
      call += 1;
      if (call === 1) return { lease_uuid: 'uuid-1', status: 'restarting' };
      // Second entry: the user's new chat message aborts the shared controller
      // while this entry is queued behind the signing mutex.
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(restartApp).toHaveBeenCalledTimes(2);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, 'uuid-2', { provisionState: 'failed' });
    const data = result.data as any;
    expect(data.failed).not.toContain('postgres');
    expect(data.cancelled).toContain('postgres');
    expect(data.message).toContain('Cancelled: postgres');
    expect(data.message).not.toContain('Failed: postgres');
  });

  it('surfaces the post-ENG-508 reason/message when the restart wait ends in failure', async () => {
    // fred v0.13.0 deleted last_error from /status; the failure signal is now
    // the curated reason/message pair. Same fixture as the legacy twin above.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      reason: 'ContainerExited',
      message: 'container exited unexpectedly',
    });
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(true);

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ContainerExited');
    expect(result.error).toContain('container exited unexpectedly');
    expect(result.error).not.toContain('App did not come back up');
  });

  it('surfaces the post-ENG-508 reason/message on a failed batch restart', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      reason: 'RestartFailed',
      message: 'restart failed; rollback failed',
    });
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(true);

    const onProgress = vi.fn();
    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' })];
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps), onProgress })
    );

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      batch: expect.arrayContaining([
        expect.objectContaining({ name: 'redis', phase: 'failed', detail: expect.stringContaining('RestartFailed') }),
      ]),
    }));
  });

  it('does NOT read /provision on the restart path (fred erases the restart-rollback signal)', async () => {
    // lease_sm.go onEnterReadyFromReplaceRecovered CLEARS Reason/Message when
    // `info.OldStopped && info.Operation == "restart"` — a restart that rolled
    // back is, by fred's own definition, back to the exact prior state. So there
    // is nothing for a restart-side rollback gate to read, and mirroring
    // update's gate onto restart would only add a round-trip and invent a
    // failure out of a stale record. This locks that decision.
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: 'ready',
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });

    const app = makeApp();
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(result.success).toBe(true);
    expect(getLeaseProvision).not.toHaveBeenCalled();
  });

  it('waits on the lease-wait deadline, not the deploy one (W6)', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });

    const app = makeApp();
    await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry([app]) })
    );

    expect(waitForLeaseStatus).toHaveBeenCalledWith(
      expect.anything(),
      app.leaseUuid,
      expect.objectContaining({ timeout: AI_LEASE_WAIT_TIMEOUT_MS })
    );
    // The split is the point: an ACTIVE lease sitting at provision_status
    // 'retained' now polls instead of resolving (SDK 0.21 classifyTerminal), so
    // this budget has to cover fred's ReconcileInterval + ProvisionTimeout.
    expect(AI_LEASE_WAIT_TIMEOUT_MS).toBeGreaterThan(AI_DEPLOY_PROVISION_TIMEOUT_MS);
  });

  it('returns failure when all batch restarts fail', async () => {
    vi.mocked(restartApp).mockRejectedValue(new ProviderApiError(409, '{"error":"invalid state for restart","code":409}'));

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

  it('S3: rejects a file-attached .json manifest with a blocked env name', async () => {
    const app = makeApp({ status: 'running' });
    const json = JSON.stringify({ image: 'redis:8', env: { LD_PRELOAD: '/evil.so' } });
    const payload: PayloadAttachment = {
      bytes: new TextEncoder().encode(json),
      filename: 'manifest.json',
      size: json.length,
      hash: 'c'.repeat(64),
    };
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      payload
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked env variable(s): LD_PRELOAD');
  });

  it('S3: rejects a file-attached .txt manifest with a blocked env name (no .json gate)', async () => {
    // .txt uploads must contain JSON and are JSON.parsed + deployed just like
    // .json — the env-name guard must not be gated on the extension, or a
    // manifest.txt bypasses the blocklist.
    const app = makeApp({ status: 'running' });
    const json = JSON.stringify({ image: 'redis:8', env: { KUBECONFIG: '/x' } });
    const payload: PayloadAttachment = {
      bytes: new TextEncoder().encode(json),
      filename: 'manifest.txt',
      size: json.length,
      hash: 'd'.repeat(64),
    };
    const result = await executeUpdateApp(
      { app_name: 'my-app' },
      makeOptions({ appRegistry: makeRegistry([app]) }),
      payload
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked env variable(s): KUBECONFIG');
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
  // clearAllMocks() keeps mockReturnValue across tests, so re-seed the default
  // (success terminal) each time; the poll-failure test overrides to true.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(false);
  });

  it('updates app and polls to ready', async () => {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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
    expect(updateApp).toHaveBeenCalled();
    // The raw HTTP wrapper is no longer on this path (ENG-774): the primitive is.
    expect(updateLease).not.toHaveBeenCalled();
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
    vi.mocked(updateApp).mockRejectedValue(new ProviderApiError(409, '{"error":"invalid state for update","code":409}'));

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
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      last_error: 'container crashed',
    });
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(true);

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
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
  });

  it('records unconfirmed — not failed — when the readiness wait rejects (timeout/error, no abort)', async () => {
    // N4, update twin of the restart case: a wait that ended without an answer
    // is silence. Contrast the branches ABOVE, which keep writing 'failed' —
    // they run on a RESOLVED status or a settled /provision read, i.e. fred
    // actually answered.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('deadline exceeded'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('may still be in progress');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'unconfirmed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('deploying');
  });

  it('does NOT mark the app failed when the UPDATE POST itself is aborted', async () => {
    // Twin of the restart POST-site guard: updateApp throwIfAborted()s after the
    // token mint and before the non-idempotent POST, so an abort here means the
    // provider was never asked and the app still runs its current version.
    vi.mocked(updateApp).mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    // stronger than "no failed write": an abort observed NOTHING, so no
    // provisioning observation exists on the entry at all.
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBeUndefined();
    expect(result.error).toContain('cancelled before the provider was asked');
    expect(result.error).not.toContain('This operation was aborted');
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
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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
    expect(updateApp).toHaveBeenCalled();
  });

  // ── rollback gate (ENG-774) ───────────────────────────────────────────────
  // Post-ENG-508 /provision shapes, verified against fred v0.13.0
  // (internal/backend/shared/leasesm/lease_sm.go entry actions +
  //  internal/api/handlers.go LeaseProvisionResponse, which has NO last_error):
  //   Update OK       {status:'ready',  fail_count:N}                       reason+message cleared
  //   Rollback OK     {status:'ready',  fail_count:N+1, reason:'UpdateFailed',
  //                    message:'update failed; rolled back to previous version'}
  //   Rollback failed {status:'failed', reason:'UpdateFailed', message:'update failed; rollback failed'}
  //   Image pull      {status:'failed', reason:'ImagePullFailed', message:'image pull failed'}
  const PREVIOUS_MANIFEST = '{"image":"redis:7"}';

  function mockUpdateReachingProvision(provision: Record<string, unknown>) {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue(provision as never);
  }

  async function runUpdate(registry: ReturnType<typeof makeRegistry>, app: AppEntry) {
    return executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );
  }

  it('reports a rolled-back update as a failure and restores the previous manifest', async () => {
    mockUpdateReachingProvision({
      status: 'ready',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to previous version',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('previous version restored');
    expect(result.error).toContain('UpdateFailed');
    expect(result.error).toContain('rolled back to previous version');
    // UpdateFailed's curated guidance is exactly the anti-redeploy warning.
    expect(result.error).toContain(FRED_REASON_GUIDANCE.UpdateFailed.nextStep);
    expect(result.error).toContain('app_releases');
    // The observation is fred's own provision.status: 'ready' means the
    // rollback landed and the lease is healthy again.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'confirmed',
      manifest: PREVIOUS_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('running');
  });

  it('reports a clean update as a success and does not revert the manifest', async () => {
    // The twin of the rollback fixture: reason/message CLEARED by
    // onEnterReadyFromReplaceCompleted. fail_count is non-zero on purpose — a
    // lease that failed at some point in the past must not poison this update.
    mockUpdateReachingProvision({ status: 'ready', fail_count: 3 });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      manifest: PREVIOUS_MANIFEST,
    }));
  });

  it('reports a failed rollback with the post-ENG-508 reason/message', async () => {
    mockUpdateReachingProvision({
      status: 'failed',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rollback failed',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Update failed and rollback failed.');
    expect(result.error).toContain('update failed; rollback failed');
    expect(result.error).toContain(`app_status("${app.name}")`);
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'failed',
      manifest: PREVIOUS_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('treats an image-pull preflight failure as update-attributable', async () => {
    // doUpdate's preflight returns Restored:false, so the lease ends Failed with
    // ReasonImagePullFailed. A gate written as `reason === "UpdateFailed"` would
    // misfile this as a post-update crash.
    mockUpdateReachingProvision({
      status: 'failed',
      fail_count: 1,
      reason: 'ImagePullFailed',
      message: 'image pull failed',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ImagePullFailed');
    expect(result.error).not.toContain('has since failed');
    // doUpdate's preflight returns BEFORE doReplaceContainers, so no container
    // was touched: there was no rollback to fail, and the old version is still
    // serving. Claiming "rollback failed" asserts a mechanism that never ran.
    expect(result.error).not.toContain('rollback failed');
    // G3: the copy used to assert `"<name>" is still running the previous
    // version` while the write below records fred's `failed` verdict — chat and
    // the sidebar badge contradicting each other on one event. fred is
    // authoritative (the lease never reached its desired state), so the badge
    // stays 'failed' and the COPY changed: it leads with the failure and its
    // cause, and keeps the previous version only as blast-radius reassurance.
    expect(result.error).toContain('the new version was never applied');
    expect(result.error).toContain('nothing was changed on the provider');
    expect(result.error).not.toContain('is still running');
    // The one actionable line for the most common update failure — previously
    // computed and then dropped, because nextStep was interpolated only on the
    // rollback-succeeded arm.
    expect(result.error).toContain(FRED_REASON_GUIDANCE.ImagePullFailed.nextStep);
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'failed',
      manifest: PREVIOUS_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('claims no verdict from a NON-TERMINAL provision carrying a stale prior reason', async () => {
    // fred's applyReplaceEntry (lease_sm.go) writes only Status + CallbackURL on
    // entering Updating — it does NOT clear a retained prior Reason/Message. And
    // the readiness wait can resolve early: on a degraded provider GET /status
    // omits provision_status (handlers.go best-effort lookup + omitempty), and
    // the SDK's classifyTerminal returns "success" for an ACTIVE lease when it
    // is absent. So this read is reachable mid-update, and the pair it carries
    // is the PREVIOUS update's verdict. Trusting it claimed a rollback failure,
    // marked the registry failed and reverted the manifest — on an update that
    // was still in flight.
    mockUpdateReachingProvision({
      status: 'updating',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to previous version',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    // No verdict ⇒ no failure claimed; fall through to the best-effort path.
    expect(result.success).toBe(true);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      manifest: PREVIOUS_MANIFEST,
    }));
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      provisionState: 'failed',
    }));
  });

  it('does not blame a rollback when the container died AFTER a successful update', async () => {
    // The residual, era-independent false positive: the update applied, the
    // container then exited, and fred stamped ContainerExited on the same
    // provision record. A describeFredFailure-only gate would report "previous
    // version restored" and revert the stored manifest — both wrong.
    mockUpdateReachingProvision({
      status: 'ready',
      fail_count: 1,
      reason: 'ContainerExited',
      message: 'container exited unexpectedly',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('update applied');
    expect(result.error).toContain('has since failed');
    expect(result.error).not.toContain('previous version restored');
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      manifest: PREVIOUS_MANIFEST,
    }));
  });

  it('falls through to the rollback branch for a reason this build does not know', async () => {
    // fred's reason set is OPEN and add-only. An unrecognized value must take the
    // conservative branch (restore + no invented guidance), never be filtered out
    // as "someone else's failure".
    mockUpdateReachingProvision({
      status: 'ready',
      fail_count: 1,
      reason: 'SomeFutureReason',
      message: 'something new happened',
    });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('previous version restored');
    expect(result.error).toContain('SomeFutureReason');
    expect(result.error).not.toContain(FRED_REASON_GUIDANCE.UpdateFailed.nextStep);
    // The observation is fred's own provision.status: 'ready' means the
    // rollback landed and the lease is healthy again.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'confirmed',
      manifest: PREVIOUS_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('running');
  });

  it('treats fred’s Unknown reason as unclassified, not as a post-update crash', async () => {
    // provisionReason() defaults a FAILED provision with no authored reason to
    // "Unknown" at fred's read boundary. It is recognized by
    // isKnownFailureReason, so a bare negative filter would read it as "the
    // update applied and something else broke" — a positive claim from zero
    // evidence. It must take the same conservative branch as an unrecognized one.
    mockUpdateReachingProvision({ status: 'failed', fail_count: 1, reason: 'Unknown' });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('has since failed');
    expect(result.error).toContain('Update failed and rollback failed.');
    // The next step is now appended on EVERY arm, so the SDK's Unknown sentence
    // — `get_logs({ lease_uuid, tail: 200 })`, a call shape barney's
    // `get_logs(app_name)` rejects — would reach chat verbatim if this site
    // read the SDK's `guidanceFor` instead of barney's remapper.
    expect(result.error).not.toContain('lease_uuid');
    expect(result.error).toContain(`get_logs("${app.name}", 200)`);
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'failed',
      manifest: PREVIOUS_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  // ── ENG-619: a 5xx from POST /update is INDETERMINATE ──────────────────────
  it.each([
    ['the SDK’s UPDATE_INDETERMINATE wrapper', new ManifestMCPError(
      ManifestMCPErrorCode.UPDATE_INDETERMINATE,
      'The provider could not durably record the update to lease l1 (HTTP 500), so it may or may not have been applied.',
      { lease_uuid: 'l1', status: 500 },
    )],
    // The SDK wraps any ProviderApiError >= 500, but a raw one reaching this
    // catch (an unwrapped throw, or a reverse proxy in front of fred minting its
    // own 502) means the same thing and must not read as a flat failure.
    ['a raw 500 from the provider', new ProviderApiError(500, '{"error":"internal server error","code":500}')],
    ['a 502 from a proxy in front of fred', new ProviderApiError(502, '{"error":"the provider backend returned an unusable error; the request was not applied","code":502}')],
  ])('reports an update whose outcome is unknown as unknown (%s)', async (_label, error) => {
    vi.mocked(updateApp).mockRejectedValue(error);

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('may or may not have been applied');
    expect(result.error).toContain(`app_status("${app.name}")`);
    expect(result.error).toContain(`app_releases("${app.name}")`);
    expect(result.error).toContain('Do NOT stop the app and redeploy');
    expect(result.error).not.toContain('Update failed:');
    // The lease is very possibly live — never mark it failed, and never claim
    // barney's stored manifest is the one running.
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      provisionState: 'failed',
    }));
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      manifest: expect.any(String),
    }));
    // The SDK's own prose names close_lease / wait_for_app_ready — tools barney
    // does not have, one of them destructive. Barney authors its own copy.
    expect(result.error).not.toContain('close_lease');
    expect(result.error).not.toContain('wait_for_app_ready');
  });

  it('calls the updateApp primitive on the fast path with the already-merged manifest', async () => {
    // `existingManifest` is deliberately NOT passed: executeUpdateApp already
    // merged the stored manifest in at plan time, so the ConfirmationCard showed
    // (and let the user edit) exactly these bytes. A second merge inside the
    // primitive would re-inject fields the user just deleted.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });

    const app = makeApp({ manifest: PREVIOUS_MANIFEST });
    const manifestJson = JSON.stringify({ image: 'redis:8' });
    const bytes = new TextEncoder().encode(manifestJson);
    const controller = new AbortController();

    await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry([app]), signal: controller.signal }),
      { bytes, filename: 'manifest.json', size: bytes.length, hash: 'c'.repeat(64) },
    );

    expect(updateApp).toHaveBeenCalledWith(
      expect.anything(),
      { address: ADDRESS, leaseUuid: app.leaseUuid, manifest: manifestJson },
      { pollOptions: false, providerUrl: app.providerUrl, signal: controller.signal },
    );
    const [, input] = vi.mocked(updateApp).mock.calls[0];
    expect('existingManifest' in input).toBe(false);
  });

  it('surfaces the post-ENG-508 reason/message when the update wait ends in failure', async () => {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
      state: LeaseState.LEASE_STATE_CLOSED,
      reason: 'ContainerExited',
      message: 'container exited unexpectedly',
    });
    vi.mocked(isLeaseFailureTerminal).mockReturnValue(true);

    const app = makeApp();
    const registry = makeRegistry([app]);
    const result = await runUpdate(registry, app);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ContainerExited');
    expect(result.error).toContain('container exited unexpectedly');
    expect(result.error).not.toContain('App did not come back up');
  });

  it('waits on the lease-wait deadline, not the deploy one (W6)', async () => {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });

    const app = makeApp();
    await runUpdate(makeRegistry([app]), app);

    expect(waitForLeaseStatus).toHaveBeenCalledWith(
      expect.anything(),
      app.leaseUuid,
      expect.objectContaining({ timeout: AI_LEASE_WAIT_TIMEOUT_MS })
    );
  });

  it('normalizes trailing-period on provision.last_error in rollback-failed branch', async () => {
    // Pass-9 follow-up: site 4. The "Update failed and rollback failed.
    // Last error: …. Use app_status(…) to check." template embeds the
    // provision.last_error mid-sentence; without normalization an upstream
    // error ending in `.` would double-up.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({
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

  it('case 3: TerminalChainStateError → both observations, derived status failed, no chain-check', async () => {
    const c = ctx();
    // Real TerminalChainStateError ctor is (leaseUuid, chainState, ctx?); the mock's
    // 1-arg ctor uses only the first arg as the message. Second arg satisfies the type.
    const result = await handleDeployManifestError(new TerminalChainStateError('lease rejected', 'rejected'), c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('lease rejected');
    // N1: BOTH observations. The chain reading is 'absent' (the poll's
    // checkChainState saw the lease leave the live set) AND provisioning is
    // definitively over — a closed lease can never be provisioned against, so
    // 'failed' is the pessimistic terminal truth, not an invented verdict.
    // Recording only the chain half derived 'stopped' (rule 2), which
    // contradicted the "Deployment failed" copy and locked the entry out of
    // app_diagnostics/app_releases.
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, 'lease-1', { chainState: 'absent', provisionState: 'failed' });
    expect(getLease).not.toHaveBeenCalled();
  });

  it('case 2 running: chain ACTIVE → running + ready progress (not failed)', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    // C1: the running branch resolves url/connection from the provider.
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-1', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '5.6.7.8', ports: { '80/tcp': { host_port: 32456 } } },
    } as any);
    const c = ctx();
    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll timeout', { partial: true }), c);
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBe('5.6.7.8:32456');
    // C1: updateApp carries url + connection now, not just the observation.
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(
      ADDRESS, 'lease-1',
      expect.objectContaining({ chainState: 'active', url: '5.6.7.8:32456', connection: expect.objectContaining({ host: '5.6.7.8' }) }),
    );
    // C1: an app displayCard with the resolved URL.
    expect(result.success && !result.requiresConfirmation && result.displayCard?.type).toBe('app');
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
    // Terminal onProgress must still fire so the ProgressCard doesn't stay stuck
    // on the last 'provisioning' update (only 'ready'/'failed' clear it).
    expect(c.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'failed', detail: expect.stringContaining('Provisioning timed out') }),
    );
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

  // Defense-in-depth (Copilot PR #106): Case 2 keys off `leaseUuid` presence,
  // not `error instanceof ManifestMCPError`. deployManifest currently always
  // wraps post-lease throws in ManifestMCPError/TerminalChainStateError, so a
  // plain Error with a leaseUuid can't happen today — but if that contract
  // ever changes, the error must still be resolved via chain-truth, not
  // misclassified as Case 1 ("no lease").
  it('case 2 (defensive): plain Error WITH leaseUuid still runs the chain-check, not Case 1', async () => {
    vi.mocked(getLease).mockResolvedValue(null as any); // → classifyLeaseChainState 'failed'
    // No diagnostics (no last_error, no logs) so the error message is exact —
    // isolates the assertion from mock state leaking across tests in this describe.
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 0 } as any);
    vi.mocked(getLeaseLogs).mockResolvedValue({ lease_uuid: 'lease-1', tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as any);
    const c = ctx();
    const result = await handleDeployManifestError(new Error('unexpected throw shape'), c);
    expect(result.success).toBe(false);
    // Proves the chain-check ran (Case 2), not Case 1: Case 1 never calls
    // appRegistry.updateApp and would surface the bare message with no
    // "Deployment failed:" prefix.
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, 'lease-1', { status: 'failed' });
    expect(result.error).toBe('Deployment failed: unexpected throw shape');
    expect(getLease).toHaveBeenCalledWith('lease-1');
  });

  it('case 2 (defensive): plain Error WITH leaseUuid, chain ACTIVE → running', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as any);
    // C1: the running branch resolves url/connection from the provider.
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-1', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '5.6.7.8', ports: { '80/tcp': { host_port: 32456 } } },
    } as any);
    const c = ctx();
    const result = await handleDeployManifestError(new Error('unexpected throw shape'), c);
    expect(result.success).toBe(true);
    expect((result.data as any).status).toBe('running');
    expect((result.data as any).url).toBe('5.6.7.8:32456');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(
      ADDRESS, 'lease-1',
      expect.objectContaining({ chainState: 'active', url: '5.6.7.8:32456' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 / G1 / G2 / G3 / G4 — writers record OBSERVATIONS, and the abort guards
// key on the error rather than on the world.
// ═══════════════════════════════════════════════════════════════════════════

describe('G1 — the abort guards key on the ERROR, not on the ambient signal', () => {
  beforeEach(() => vi.clearAllMocks());

  // The scenario the old `signal?.aborted` guards got wrong: the shared chat
  // controller is aborted by ANY new user message (aiActions/sendMessage), so a
  // real provider failure that happens to land while the user is typing was
  // reported as "cancelled before the provider was asked; the app is unchanged"
  // — a confident false statement about a genuine provider failure.
  //
  // What the guard decides is the OPERATION's story. C2/C3 separates that from
  // the workload OBSERVATION: a POST-site throw is about initiating the restart,
  // so it reports a failed operation and records nothing.
  it('restart POST: a provider 5xx landing under an aborted signal is a failure, not a cancellation', async () => {
    vi.mocked(restartApp).mockRejectedValue(new ProviderApiError(503, '{"error":"backend unavailable","code":503}'));

    const app = makeApp({ chainState: 'active', provisionState: 'confirmed' });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();

    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Restart failed');
    expect(result.error).not.toContain('cancelled');
    expect(result.error).not.toContain('the app is unchanged');
    // …and no provisioning verdict is invented from it. fred's 500 comes from
    // `routeReplaceRestart`'s prelude, before the actor handoff — the containers
    // were never touched, so the app is still running.
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({ provisionState: expect.anything() }));
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
  });

  it('restart WAIT: a genuine wait failure under an aborted signal is still recorded', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('deadline exceeded'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();

    await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    // G1's point is unchanged and is what this test exists for: a real wait
    // failure that merely COINCIDES with an aborted signal is still recorded,
    // because the gate is the error's identity and not the ambient state. N4
    // only changes WHICH observation gets recorded — 'unconfirmed', because a
    // rejected wait never carries a provider verdict.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'unconfirmed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('unconfirmed');
  });

  it('update POST: a 4xx landing under an aborted signal is a failure, not a cancellation', async () => {
    // Deliberately NOT a 5xx: those are ENG-619 INDETERMINATE and take their own
    // branch ABOVE the abort guard, which is itself part of the ordering this
    // pins — an ambiguous 500 must never be re-told as "the app is unchanged".
    vi.mocked(updateApp).mockRejectedValue(new ProviderApiError(400, '{"error":"bad manifest","code":400}'));

    const app = makeApp({ chainState: 'active', provisionState: 'confirmed' });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();

    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Update failed');
    expect(result.error).not.toContain('cancelled');
    // C3: a rejected manifest means the replacement never started, so the
    // PREVIOUS workload is untouched — the operation failed, the app did not.
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({ provisionState: expect.anything() }));
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
  });

  it('batch restart: one entry’s real failure is not relabelled cancelled by an abort', async () => {
    // Where the ambient read bit hardest: N apps queue behind the signing mutex,
    // so ONE abort used to relabel every concurrent genuine provider failure.
    const controller = new AbortController();
    vi.mocked(restartApp).mockImplementation(async () => {
      controller.abort();
      throw new ProviderApiError(503, '{"error":"backend unavailable","code":503}');
    });

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com', chainState: 'active', provisionState: 'confirmed' })];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    const data = result.data as any;
    expect(data?.cancelled ?? []).not.toContain('redis');
    // Bucketed as a failed OPERATION (below), with no workload observation.
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, 'uuid-1', expect.objectContaining({ provisionState: expect.anything() }));
  });
});

describe('G2 — fred’s transient `failing` is a verdict, not silence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a container that died right after a successful update, even mid-`failing`', async () => {
    // fred v0.13.0 onEnterFailing (internal/backend/shared/leasesm/lease_sm.go)
    // writes {Status: failing, FailCount++, Reason: ContainerExited, Message:
    // 'container exited'} SYNCHRONOUSLY and only flips to `failed` when the async
    // diagnostics gather fires. `Failing` is entered ONLY from `Ready`, so this
    // read means "the update landed and then the container died". The old
    // positive gate (`status === 'ready' || status === 'failed'`) treated the
    // whole window as unsettled and fell straight through to the SUCCESS path.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failing', fail_count: 1, reason: 'ContainerExited', message: 'container exited',
    } as never);

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('has since failed');
    expect(result.error).toContain('container exited');
    // ContainerExited is NOT update-attributable, so this is the applied-then-died
    // arm: the manifest is NOT reverted and the provider verdict is recorded.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'failed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('still claims no verdict from a genuinely mid-flight provision read', async () => {
    // The inversion must not swallow the case the gate originally existed for:
    // `updating` is fred's in-flight status and its retained reason/message pair
    // belongs to the PREVIOUS update. (Twin of the existing 'updating' test —
    // kept here for `restarting`, the other mid-flight value.)
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'restarting', fail_count: 1, reason: 'UpdateFailed', message: 'update failed; rolled back',
    } as never);

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(true);
  });

  it('treats an ABSENT provision_status as unsettled, not as a verdict', async () => {
    // fred's `omitempty` drops the field when its best-effort provision lookup
    // fails on a degraded provider. Inverting the gate must not turn that
    // silence into "trust the retained pair".
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({
      fail_count: 1, reason: 'UpdateFailed', message: 'update failed; rolled back',
    } as never);

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(true);
  });
});

describe('G4 — a batch-restart abort at the WAIT site is a cancellation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('buckets every in-flight entry under Cancelled, never Failed', async () => {
    // The POST-site fix already returned `cancelled`; the readiness-WAIT catch
    // still called updateProgress('failed', …) and returned null, so clicking
    // Stop during `restart all` landed every in-flight app under `Failed:` —
    // inconsistent with the single-restart path's copy for the identical event.
    const controller = new AbortController();
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockImplementation(async () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
      makeApp({ name: 'mongo', leaseUuid: 'uuid-3', providerUrl: 'https://fred3.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    // All three POSTs landed, so all three reached the wait.
    expect(restartApp).toHaveBeenCalledTimes(3);
    // Nothing landed and nothing failed: summarizeBatchResult's all-cancelled
    // shape. Before the fix this read `All restarts failed: redis, postgres,
    // mongo` — the same event the single-restart path calls a cancellation.
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cancelled:');
    for (const name of ['redis', 'postgres', 'mongo']) {
      expect(result.error).toContain(name);
    }
    expect(result.error).not.toContain('Failed:');
    expect(result.error).not.toContain('All restarts failed');
    // …and nothing was recorded about provisioning: the wait observed nothing.
    for (const a of apps) {
      expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, a.leaseUuid, { provisionState: 'failed' });
      expect(registry.getAppByLease(ADDRESS, a.leaseUuid)?.provisionState).toBeUndefined();
    }
  });
});

describe('F4 — a writer with no observation invents none', () => {
  beforeEach(() => vi.clearAllMocks());

  it('UPDATE_INDETERMINATE leaves provisionState exactly as it was', async () => {
    // "Indeterminate" IS the state. The 500 is ambiguous by construction (fred
    // answers it both when it refuses before the backend and when the backend
    // applied the update but persisting the payload failed), so writing any
    // provisioning verdict here would manufacture one.
    vi.mocked(updateApp).mockRejectedValue(new ManifestMCPError(
      ManifestMCPErrorCode.UPDATE_INDETERMINATE,
      'The provider could not durably record the update to lease l1 (HTTP 500).',
      { lease_uuid: 'l1', status: 500 },
    ));

    const app = makeApp({ provisionState: 'confirmed', chainState: 'active' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('may or may not have been applied');
    expect(registry.updateApp).not.toHaveBeenCalled();
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
  });

  it('an aborted restart POST leaves the entry’s observations untouched', async () => {
    vi.mocked(restartApp).mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));

    const app = makeApp({ provisionState: 'confirmed', chainState: 'active' });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();

    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(result.error).toContain('cancelled before the provider was asked');
    expect(registry.updateApp).not.toHaveBeenCalled();
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('confirmed');
  });

  it('stopping a failed deploy records the chain fact without erasing the diagnosis', async () => {
    // Documented interaction, not an accident: derivation puts a provider
    // `failed` verdict above chain-absence, so an app that failed to deploy and
    // was then stopped still reads 'failed'. Both labels are terminal and both
    // free the name for reuse, and 'failed' is the more informative of the two.
    // Making it read 'stopped' would mean the stop path CLEARING an observation
    // it never disproved.
    vi.mocked(stopApp).mockResolvedValue({ outcome: 'stopped' } as any);

    const app = makeApp({ provisionState: 'failed', status: 'failed' });
    const registry = makeRegistry([app]);
    await executeConfirmedStopApp(
      { app_name: app.name, leaseUuid: app.leaseUuid },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
    );

    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { chainState: 'absent' });
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.chainState).toBe('absent');
    expect(stored?.provisionState).toBe('failed');
    expect(stored?.status).toBe('failed');
  });

  // C2/C3. The POST-site catches used to write 'failed' under the claim "the
  // provider was asked and answered with a failure — a genuine verdict". Several
  // paths reach them where nothing observed the workload at all, and 'failed'
  // drops a healthy app out of list_apps(running), restart_app and DNS polling.
  it('a token mint that fails before the restart POST leaves the app running', async () => {
    // restartApp mints its ADR-036 token BEFORE the POST, so a wallet/signing
    // failure here means the provider was never asked. Not an AbortError, so it
    // falls past the cancellation arm into the general catch.
    vi.mocked(restartApp).mockRejectedValue(new Error('Request rejected by the wallet'));

    const app = makeApp({ provisionState: 'confirmed', chainState: 'active' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
    );

    // The OPERATION is still reported as failed — only the observation is gone.
    expect(result.success).toBe(false);
    expect(result.error).toContain('Restart failed: Request rejected by the wallet');
    expect(registry.updateApp).not.toHaveBeenCalled();
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
  });

  it('a 400 bad-manifest update leaves the previous workload untouched', async () => {
    // The strongest case: fred rejected the manifest, so the replacement never
    // started and the PREVIOUS version is still serving. (5xx never reaches this
    // arm — `isIndeterminateUpdateError` takes it first.)
    vi.mocked(updateApp).mockRejectedValue(new ProviderApiError(400, '{"error":"bad manifest","code":400}'));

    const app = makeApp({ provisionState: 'confirmed', chainState: 'active', manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Update failed');
    expect(registry.updateApp).not.toHaveBeenCalled();
    const stored = registry.getAppByLease(ADDRESS, app.leaseUuid);
    expect(stored?.provisionState).toBe('confirmed');
    expect(stored?.status).toBe('running');
    // The stored manifest is still the live one: the new one is written only
    // AFTER the primitive resolves.
    expect(stored?.manifest).toBe('{"image":"redis:7"}');
  });

  it('a client-side INVALID_CONFIG from the manifest merge records nothing', async () => {
    // `updateApp` merges the manifest and raises INVALID_CONFIG on bad JSON or an
    // unknown service name — entirely before the POST. Nothing left the browser.
    vi.mocked(updateApp).mockRejectedValue(new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'existing_manifest is not a stack manifest',
    ));

    const app = makeApp({ provisionState: 'confirmed', chainState: 'active' });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(registry.updateApp).not.toHaveBeenCalled();
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('running');
  });

  it('a refused batch restart records nothing either', async () => {
    // The bulk path must not disagree with the single path about what a refusal
    // means — that split is how the two sets drifted in the first place.
    vi.mocked(restartApp).mockRejectedValue(new ProviderApiError(500, '{"error":"internal error","code":500}'));

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com', provisionState: 'confirmed', chainState: 'active' })];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('All restarts failed: redis');
    expect(registry.updateApp).not.toHaveBeenCalled();
    expect(registry.getAppByLease(ADDRESS, 'uuid-1')?.status).toBe('running');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G1 / G2 / G3 / G4 — second pass.
//
// The first pass proved each fix on its own. These close the gaps it left: the
// CROSSING cases, where an abort and a genuine failure arrive together and the
// two must be told apart per-entry, and the two G2 arms the inversion was
// actually chosen FOR — a status this client does not model, and a teardown
// verdict. Those two are the only place the direction of the gate is
// observable; without them "inverted" and "widened to {ready, failed, failing}"
// are indistinguishable.
// ═══════════════════════════════════════════════════════════════════════════

describe('G1 (cont.) — error identity at the sites the first pass left uncovered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update WAIT: a genuine wait failure under an aborted signal is still recorded', async () => {
    // Twin of the restart-WAIT case, on the path that did not have one. The old
    // `if (!signal?.aborted)` gate skipped the write here too, so an app whose
    // readiness wait died of a real transport fault kept rendering 'running'
    // for as long as nobody ran app_status on it.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('provider connection reset'));

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const controller = new AbortController();
    controller.abort();

    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    // As above: G1 pins that the write HAPPENS despite the ambient abort; N4
    // pins that a connection reset is silence about provisioning, not a verdict.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, { provisionState: 'unconfirmed' });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('deploying');
  });

  it('batch restart POST: a real provider failure under an aborted signal lands in Failed, never Cancelled', async () => {
    // The existing G1 batch test asserts on `result.data.cancelled`, but an
    // all-nothing-landed batch returns `{success:false, error}` with NO `data`
    // at all — so that assertion cannot fail. Assert the string the user
    // actually reads instead. Before the fix this said "No restarts completed —
    // Cancelled: redis.", which is a 503 from fred re-told as the user's own
    // cancellation.
    const controller = new AbortController();
    vi.mocked(restartApp).mockImplementation(async () => {
      controller.abort();
      throw new ProviderApiError(503, '{"error":"backend unavailable","code":503}');
    });

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com', chainState: 'active', provisionState: 'confirmed' })];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('All restarts failed: redis');
    expect(result.error).not.toContain('Cancelled');
    // The OPERATION is reported failed; the app it never touched stays running.
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, 'uuid-1', expect.objectContaining({ provisionState: expect.anything() }));
    expect(registry.getAppByLease(ADDRESS, 'uuid-1')?.status).toBe('running');
  });
});

describe('G2 (cont.) — the inversion, on the values it was chosen for', () => {
  beforeEach(() => vi.clearAllMocks());

  const ROLLED_BACK_MANIFEST = '{"image":"redis:7"}';

  function mockUpdateReachingProvisionStatus(provision: Record<string, unknown>) {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue(provision as never);
  }

  it('trusts a failure verdict carried by a provision status this client does not model', async () => {
    // THE point of inverting the gate rather than widening it. fred v0.13.0's
    // ProvisionStatus set (internal/backend/client.go) is nine values today and
    // the constant block is add-only; the previous positive gate
    // (`status === 'ready' || status === 'failed'`) meant every value fred adds
    // LATER defaults to silence — reason + message present, failure ignored,
    // update reported as a success. Inverted, an unmodelled status defaults to
    // "trust the verdict", which is the safe direction: the worst case is a
    // conservative failure report on an app that is fine, not a success report
    // on an app whose update was rolled back.
    //
    // The copy takes the rollback-failed arm because an unmodelled status is not
    // `ready` — deliberately the arm that never claims the update took, and it
    // points at app_status rather than asserting what is serving.
    mockUpdateReachingProvisionStatus({
      status: 'quarantined',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to previous version',
    });

    const app = makeApp({ manifest: ROLLED_BACK_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('update failed; rolled back to previous version');
    expect(result.error).toContain(`app_status("${app.name}")`);
    // The manifest the provider never ran is not left in the registry.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, app.leaseUuid, {
      provisionState: 'failed',
      manifest: ROLLED_BACK_MANIFEST,
    });
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('trusts a teardown verdict — `deprovisioning` is settled, not mid-flight', async () => {
    // `deprovisioning` and `retained` are deliberately OUT of the unsettled set,
    // and nothing pinned that. fred enters Deprovisioning from Failing on
    // evDeprovisionRequested (lease_sm.go), so a /provision read here means the
    // lease is being torn down: the update is not going to land, and the
    // retained reason/message pair is the closest thing to a verdict there will
    // ever be. Reporting success would be the worst possible answer.
    mockUpdateReachingProvisionStatus({
      status: 'deprovisioning',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to previous version',
    });

    const app = makeApp({ manifest: ROLLED_BACK_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.status).toBe('failed');
  });

  it('still stays silent on fred’s own `unknown`', async () => {
    // The judgement call inside the inversion, pinned so it cannot be quietly
    // dropped: `unknown` is fred's name for "I cannot tell", so the pair beside
    // it is not a verdict about anything. FORWARD GUARD — this also passed
    // under the old positive gate, which called every non-{ready,failed} status
    // unsettled. It proves the inversion did not overshoot, not that it fixed
    // something.
    mockUpdateReachingProvisionStatus({
      status: 'unknown',
      fail_count: 1,
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to previous version',
    });

    const app = makeApp({ manifest: ROLLED_BACK_MANIFEST });
    const registry = makeRegistry([app]);
    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(true);
    expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, app.leaseUuid, expect.objectContaining({
      manifest: ROLLED_BACK_MANIFEST,
    }));
  });
});

describe('G3 (cont.) — the ProgressCard detail must not re-assert what the copy dropped', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the preflight failure on the progress row without a status claim', async () => {
    // G3 fixed the chat copy; the ProgressCard row is the OTHER surface that
    // sits next to the badge, and it renders `detail` verbatim. Pin that it
    // carries the same story — failure first, "nothing was changed" as blast
    // radius — so the contradiction cannot come back through the progress path.
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    });
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed', fail_count: 1, reason: 'ImagePullFailed', message: 'image pull failed',
    } as never);

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const onProgress = vi.fn();
    await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
      makePayload(),
    );

    const details = onProgress.mock.calls.map((c) => (c[0] as { detail?: string }).detail ?? '');
    expect(details.some((d) => d.includes('nothing was changed'))).toBe(true);
    // The badge derived from this write is 'failed'; no surface may say the app
    // is running, and none may claim a rollback that by construction never ran.
    expect(details.some((d) => d.includes('is still running'))).toBe(false);
    expect(details.some((d) => d.includes('rollback failed'))).toBe(false);
  });
});

describe('G4 (cont.) — a mixed batch keeps the two outcomes apart per entry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes the aborted waits to Cancelled and the one unanswered wait to Still restarting', async () => {
    // Where G1 and G4 meet, and the only shape that distinguishes the fix from
    // "bucket everything as cancelled once the signal is aborted". All three
    // POSTs land; the user presses Stop; two waits reject with the signal's own
    // reason and one rejects with a real transport fault. The abort is ambient
    // for ALL THREE, so ambient state cannot separate them — only the error can.
    const controller = new AbortController();
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockImplementation(async (_ctx: unknown, uuid: unknown) => {
      controller.abort();
      if (uuid === 'uuid-3') throw new Error('provider connection reset');
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
      makeApp({ name: 'mongo', leaseUuid: 'uuid-3', providerUrl: 'https://fred3.example.com' }),
    ];
    const registry = makeRegistry(apps);
    const entries = apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, signal: controller.signal })
    );

    expect(restartApp).toHaveBeenCalledTimes(3);
    // Both buckets are named, and neither is `Failed:` — mongo's wait ended
    // without an answer, so CP2 buckets it with its observation instead of
    // under `Failed:`. (Originally this asserted `Failed: mongo.`; the abort /
    // non-abort separation it exists to pin is unchanged, only mongo's bucket.)
    const message = (result.data as { message: string }).message;
    expect(result.success).toBe(true);
    expect(message).toContain('Still restarting:');
    expect(message).toContain('mongo');
    expect(message).toContain('Cancelled:');
    expect(message).toContain('redis');
    expect(message).toContain('postgres');
    expect(message).not.toContain('Failed:');
    expect(message).not.toContain('All restarts failed');
    expect((result.data as { failed: string[] }).failed).toEqual([]);

    // Only the entry whose wait failed for a NON-abort reason is recorded, and
    // what it records is 'unconfirmed' (N4): a connection reset says the wait
    // ended without an answer, not that the provider failed the restart. The
    // aborted two record nothing at all — that is still the G1/G4 separation
    // this test exists to pin, and it survives the value change.
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'uuid-3', { provisionState: 'unconfirmed' });
    expect(registry.getAppByLease(ADDRESS, 'uuid-3')?.status).toBe('deploying');
    for (const uuid of ['uuid-1', 'uuid-2']) {
      expect(registry.updateApp).not.toHaveBeenCalledWith(ADDRESS, uuid, expect.objectContaining({ provisionState: expect.anything() }));
      expect(registry.getAppByLease(ADDRESS, uuid)?.provisionState).toBeUndefined();
      expect(registry.getAppByLease(ADDRESS, uuid)?.status).toBe('running');
    }
  });
});

describe('CP2 — a wait that never got an answer is not a failure', () => {
  beforeEach(() => vi.clearAllMocks());

  const RESTART_OK = { lease_uuid: 'lease-uuid', status: 'restarting' };

  function batchEntries(apps: AppEntry[]) {
    return apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! }));
  }

  it('batch restart: an unanswered readiness wait lands in Still restarting, not Failed', async () => {
    // The catch already recorded 'unconfirmed' but returned null, so the
    // registry said 'deploying' while the summary said "All restarts failed" —
    // a failure verdict fred never issued.
    vi.mocked(restartApp).mockResolvedValue(RESTART_OK);
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('waitForLeaseStatus timed out after 900000ms'));

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const registry = makeRegistry(apps);

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries: batchEntries(apps) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(true);
    const data = result.data as { unconfirmed: Array<{ name: string; detail?: string }>; failed: string[]; message: string };
    expect(data.unconfirmed.map((u) => u.name)).toEqual(['redis', 'postgres']);
    expect(data.failed).toEqual([]);
    expect(data.message).toContain('Still restarting:');
    expect(data.message).toContain('app_status("redis")');
    expect(data.message).not.toContain('All restarts failed');
    // The bucket and the registry now agree.
    for (const a of apps) {
      expect(registry.getAppByLease(ADDRESS, a.leaseUuid)?.provisionState).toBe('unconfirmed');
      expect(registry.getAppByLease(ADDRESS, a.leaseUuid)?.status).toBe('deploying');
    }
  });

  it('batch restart: a poll_verdict rejection still lands in Failed', async () => {
    // Guard, not a repro: waitForLeaseStatus RESOLVES at every terminal today,
    // so this arm is unreachable from the SDK — it exists so a future build
    // that routes a verdict out through the rejection keeps the Failed bucket.
    vi.mocked(restartApp).mockResolvedValue(RESTART_OK);
    vi.mocked(waitForLeaseStatus).mockRejectedValue(
      new ProviderApiError(0, 'Lease uuid-1 is ACTIVE but provisioning failed', { kind: 'poll_verdict' })
    );

    const apps = [makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' })];
    const registry = makeRegistry(apps);

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries: batchEntries(apps) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('All restarts failed: redis');
    expect(registry.getAppByLease(ADDRESS, 'uuid-1')?.provisionState).toBe('failed');
  });

  it('single restart: the progress row stops calling an unanswered wait a polling failure', async () => {
    vi.mocked(restartApp).mockResolvedValue(RESTART_OK);
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('provider connection reset'));

    const app = makeApp();
    const registry = makeRegistry([app]);
    const onProgress = vi.fn();

    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress })
    );

    const details = onProgress.mock.calls.map((c) => (c[0] as { detail?: string }).detail ?? '');
    expect(details).toContain('Restart not confirmed');
    expect(details).not.toContain('Restart polling failed');
    expect(result.error).toContain('Restart may still be in progress');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('unconfirmed');
  });

  it('single restart: a poll_verdict rejection reports the failure it records', async () => {
    // Same defensive arm as the batch guard above — but here the message was
    // actively wrong: it recorded 'failed' and told the user the restart "may
    // still be in progress".
    vi.mocked(restartApp).mockResolvedValue(RESTART_OK);
    vi.mocked(waitForLeaseStatus).mockRejectedValue(
      new ProviderApiError(0, 'Lease is ACTIVE but provisioning failed: ImagePullFailed', { kind: 'poll_verdict' })
    );

    const app = makeApp();
    const registry = makeRegistry([app]);

    const result = await executeConfirmedRestartApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Restart failed: ');
    expect(result.error).toContain('ImagePullFailed');
    expect(result.error).not.toContain('may still be in progress');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('failed');
  });

  it('update: the progress row stops calling an unanswered wait a polling failure', async () => {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('provider connection reset'));

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);
    const onProgress = vi.fn();

    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
      makePayload(),
    );

    const details = onProgress.mock.calls.map((c) => (c[0] as { detail?: string }).detail ?? '');
    expect(details).toContain('Update not confirmed');
    expect(details).not.toContain('Update polling failed');
    expect(result.error).toContain('Update may still be in progress');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('unconfirmed');
  });

  it('update: a poll_verdict rejection reports the failure it records', async () => {
    vi.mocked(updateApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'updating' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(
      new ProviderApiError(0, 'Lease entered terminal state LEASE_STATE_CLOSED', { kind: 'poll_verdict' })
    );

    const app = makeApp({ manifest: '{"image":"redis:7"}' });
    const registry = makeRegistry([app]);

    const result = await executeConfirmedUpdateApp(
      { app_name: app.name, leaseUuid: app.leaseUuid, providerUrl: app.providerUrl },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry }),
      makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Update failed: ');
    expect(result.error).toContain('LEASE_STATE_CLOSED');
    expect(result.error).not.toContain('may still be in progress');
    expect(registry.getAppByLease(ADDRESS, app.leaseUuid)?.provisionState).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Integration seam: the restart wait catch (this file) and the batch summary
// (batchRunner.ts) were changed independently, so nothing pinned them together.
// ---------------------------------------------------------------------------

describe('batch summary and progress agree on an unconfirmed batch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('batch restart: an all-unanswered batch is unconfirmed in the message AND the progress phase', async () => {
    vi.mocked(restartApp).mockResolvedValue({ lease_uuid: 'lease-uuid', status: 'restarting' });
    vi.mocked(waitForLeaseStatus).mockRejectedValue(new Error('waitForLeaseStatus timed out after 900000ms'));

    const apps = [
      makeApp({ name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' }),
      makeApp({ name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' }),
    ];
    const onProgress = vi.fn();

    const result = await executeConfirmedRestartApp(
      { app_name: 'all', entries: apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid, providerUrl: a.providerUrl! })) },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: makeRegistry(apps), onProgress })
    );

    expect(result.success).toBe(true);
    expect((result.data as { message: string }).message).toContain('Still restarting:');

    const last = onProgress.mock.calls.at(-1)![0] as { phase: string; detail?: string };
    expect(last.phase).toBe('ready');
    expect(last.detail).toBe('2 still restarting');
  });

  it('batch deploy: an all-succeeded batch still gets the unchanged headline and phase', async () => {
    // Regression guard on the path R1/R2 did NOT change — it passes both ways.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, callOptions) => {
      await callOptions?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return makeDeployResult();
    });
    mockLiveBatchCatalog();
    const onProgress = vi.fn();
    const entries = [
      { app_name: 'game1', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
      { app_name: 'game2', size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() },
    ];

    const result = await executeConfirmedBatchDeploy(
      await confirmedBatchArgs(entries), CLIENT_MANAGER, makeOptions({ appRegistry: makeRegistry(), onProgress })
    );

    expect(result.success).toBe(true);
    const last = onProgress.mock.calls.at(-1)![0] as { phase: string; detail?: string };
    expect(last.phase).toBe('ready');
    expect(last.detail).toBe('All 2 apps deployed!');
  });
});
