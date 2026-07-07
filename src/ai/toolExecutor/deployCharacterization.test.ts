import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeConfirmedDeployApp,
  executeConfirmedBatchDeploy,
} from './compositeTransactions';
// NOTE: executeConfirmedBatchDeploy is imported in Task 6 (its first use) and
// getLease in Task 5 — deferred so every intermediate C0 `npm run build` gate
// stays free of noUnusedLocals (TS6133) errors.
import type { ToolExecutorOptions, PayloadAttachment } from './types';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import { makeRegistry } from './testHelpers';
import { LeaseState } from '../../api/billing';

/**
 * ============================================================================
 * ENG-279 DEPLOY-PATH REWRITE — CHARACTERIZATION GATE (spec §4 C0)
 * ============================================================================
 * These tests PIN the CURRENT observable behavior of the confirmed deploy /
 * batch-deploy path at the TOOL-OUTPUT BOUNDARY: ToolResult shape,
 * DeployProgress phase sequence, registry addApp/updateApp writes, and
 * connection/URL shaping. They are the regression gate for C1–C4: after each
 * commit these MUST stay green, EXCEPT the annotated allowed-deltas below.
 *
 * They intentionally assert on OUTPUTS, not on internal call args
 * (cosmosTx/waitForLeaseReady are deleted in C2). C2/C3 keep this file green
 * by re-pointing the mocks below to `deployManifest` while leaving the
 * assertions untouched — that is the behavior-preservation proof.
 *
 * ----------------------------------------------------------------------------
 * ALLOWED BEHAVIOR DELTAS (assertions here MAY change in the named commit;
 * all OTHER assertions are frozen):
 *
 *  D-A. Custom-domain attach: NON-FATAL → FATAL (spec §3.10, commit C2/C3).
 *       Today a set-domain failure is non-fatal: the app still reports
 *       "live" with a `custom_domain_error`. After C2/C3, deployManifest sets
 *       the domain in-deploy and a failure lands the deploy in `failed[]`.
 *       (No custom-domain success/failure case is pinned in THIS file — it is
 *       called out so C2/C3 authors know NOT to add a non-fatal pin here.)
 *
 *  D-B. fallbackToChainState is TRIMMED, NOT REMOVED (spec §3.7, commit C2/C3).
 *       FROZEN core: an AMBIGUOUS post-lease poll throw on a chain-ACTIVE
 *       lease MUST still report ready/running — never "failed"
 *       (see `poll throws but chain ACTIVE → still reports ready`). CHANGED:
 *       getLease UNAVAILABLE (null/throw) maps deploying→FAILED after the
 *       trim (correctness fix); the PENDING→deploying pin
 *       (`poll inconclusive + chain PENDING → deploying`) stays.
 *
 *  D-C. WebSocket real-time wait → HTTP poll only (spec §5, commit C2).
 *       deployManifest is poll-only; the `waitForLeaseReady`→WS path is gone
 *       for deploy. No phase/ToolResult assertion here depends on WS, so this
 *       delta touches no pin — listed for completeness.
 * ============================================================================
 */

// ---- Mocks: mirror compositeTransactions.test.ts conventions verbatim ----
vi.mock('../../api/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/billing')>();
  return { ...actual, getCreditAccount: vi.fn(), getLease: vi.fn() };
});
vi.mock('../../api/sku', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sku')>();
  return { ...actual, getProviders: vi.fn() };
});
vi.mock('../../api/provider-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/provider-api')>();
  return { ...actual, getLeaseConnectionInfo: vi.fn() };
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
// C2 re-point: the confirmed single-deploy path now drives deployManifest +
// getReadClient. Spread the original so manifest.ts's buildManifest/mergeManifest/
// metaHashHex re-exports survive.
vi.mock('@manifest-network/manifest-mcp-fred', async (importOriginal) => ({
  ...(await importOriginal()),
  deployManifest: vi.fn(),
  TerminalChainStateError: class TerminalChainStateError extends Error {
    constructor(m: string) { super(m); this.name = 'TerminalChainStateError'; }
  },
}));
vi.mock('../../api/readClient', () => ({
  getReadClient: vi.fn().mockResolvedValue({ query: {} }),
}));
vi.mock('../../utils/errors', async (orig) => {
  const actual = await orig<typeof import('../../utils/errors')>();
  return { ...actual, logError: vi.fn() };
});
vi.mock('../../registry/appRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry/appRegistry')>();
  return { ...actual, validateAppName: vi.fn().mockReturnValue(null) };
});
vi.mock('../../api/leaseByCustomDomain', () => ({
  queryLeaseByCustomDomain: vi.fn().mockResolvedValue(null),
}));

import { getLeaseConnectionInfo } from '../../api/provider-api';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { deployManifest } from '@manifest-network/manifest-mcp-fred';
import { getLease } from '../../api/billing';

const ADDRESS = 'manifest1abc';
const CLIENT_MANAGER = {} as CosmosClientManager;
const SAMPLE_TIERS = [
  { skuName: 'docker-micro', skuUuid: 'sku-1', providerUuid: 'p1', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'sku-2', providerUuid: 'p1', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
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
  return { bytes: new Uint8Array([1, 2, 3]), filename: 'manifest.json', size: 3, hash: 'a'.repeat(64) };
}

const CONFIRMED_ARGS = {
  app_name: 'test-app',
  size: 'small',
  skuUuid: 'sku-1',
  providerUuid: 'p1',
  providerUrl: 'https://fred.example.com',
};

/** Happy path: lease created, uploaded, polled ACTIVE, instance-port URL. */
function mockHappyPath() {
  // C2/C3: both the single-deploy and batch paths now drive deployManifest —
  // fire onLeaseCreated (registry addApp + uploading phase), one provisioning
  // tick, then resolve with the pinned instance-port connection.
  vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
    await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
    opts?.pollOptions?.onProgress?.({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'provisioning' } as never);
    return {
      lease_uuid: 'new-lease-uuid',
      provider_uuid: 'p1',
      provider_url: 'https://fred.example.com',
      state: LeaseState.LEASE_STATE_ACTIVE,
      connection: { host: '127.0.0.1', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    } as never;
  });
}

describe('C0 characterization — executeConfirmedDeployApp happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins the success ToolResult shape (message/name/url/status + app displayCard)', async () => {
    mockHappyPath();
    const result = await executeConfirmedDeployApp(CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions(), makePayload());

    expect(result.success).toBe(true);
    const data = result.data as { message: string; name: string; url: string; status: string };
    // SENTINEL: run, read the actual value from the failure, paste it here.
    // Expected current value: 'App "test-app" is live!'
    expect(data.message).toBe('App "test-app" is live!');
    expect(data.name).toBe('test-app');
    expect(data.url).toBe('127.0.0.1:32456');
    expect(data.status).toBe('running');

    expect(result.success && !result.requiresConfirmation && result.displayCard?.type).toBe('app');
    if (result.success && !result.requiresConfirmation && result.displayCard?.type === 'app') {
      expect(result.displayCard.data.url).toBe('127.0.0.1:32456');
      expect(result.displayCard.data.status).toBe('running');
      expect(result.displayCard.data.customDomain).toBeUndefined();
    }
  });

  it('pins the DeployProgress phase sequence: creating_lease → uploading → provisioning → ready', async () => {
    mockHappyPath();
    const onProgress = vi.fn();
    await executeConfirmedDeployApp(CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ onProgress }), makePayload());

    const phases = onProgress.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phases).toEqual(['creating_lease', 'uploading', 'provisioning', 'ready']);
  });
});

describe('C0 characterization — registry writes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins addApp(deploying) then updateApp(running,url) field writes', async () => {
    mockHappyPath();
    const registry = makeRegistry();
    await executeConfirmedDeployApp(CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry }), makePayload());

    expect(registry.addApp).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({
        name: 'test-app',
        leaseUuid: 'new-lease-uuid',
        size: 'small',
        providerUuid: 'p1',
        providerUrl: 'https://fred.example.com',
        status: 'deploying',
      }),
    );

    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS,
      'new-lease-uuid',
      expect.objectContaining({ status: 'running', url: '127.0.0.1:32456' }),
    );
  });
});

describe('C0 characterization — connection/URL shaping', () => {
  beforeEach(() => vi.clearAllMocks());

  async function deployWithConnection(connection: unknown): Promise<{ url?: string; status?: string }> {
    // C2 re-point: URL shaping now runs off DeployResult.connection returned by
    // deployManifest (deriveUrlFromConnection), no getLeaseConnectionInfo round-trip.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return {
        lease_uuid: 'new-lease-uuid', provider_uuid: 'p1', provider_url: 'https://fred.example.com',
        state: LeaseState.LEASE_STATE_ACTIVE, connection,
      } as never;
    });
    const result = await executeConfirmedDeployApp(CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions(), makePayload());
    return result.data as { url?: string; status?: string };
  }

  it('shapes URL from top-level ports (IP:port)', async () => {
    const data = await deployWithConnection({ host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } });
    expect(data.url).toBe('127.0.0.1:32456');
  });

  it('promotes stack primary-service FQDN to https:// (no port)', async () => {
    const data = await deployWithConnection({
      host: '64.29.115.29',
      services: {
        db: { instances: [{ ports: { '3306/tcp': { host_ip: '0.0.0.0', host_port: 32100 } } }] },
        wordpress: {
          fqdn: 'wp-abc123.barney8.manifest0.net',
          instances: [{ ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32769 } } }],
        },
      },
    });
    expect(data.url).toBe('https://wp-abc123.barney8.manifest0.net');
  });

  it('falls back to resolveAppUrl (getLeaseConnectionInfo) when DeployResult.connection is absent', async () => {
    // C2 re-point: when deployManifest returns no connection (degraded), the
    // executor falls back to resolveAppUrl → getLeaseConnectionInfo. Pinned URL
    // '1.2.3.4:32456' preserved; the fred-status-endpoints seam is gone (D-C:
    // deployManifest is poll-only and owns connection resolution).
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      return {
        lease_uuid: 'new-lease-uuid', provider_uuid: 'p1', provider_url: 'https://fred.example.com',
        state: LeaseState.LEASE_STATE_ACTIVE, connectionError: 'no connection in result',
      } as never;
    });
    vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
      lease_uuid: 'new-lease-uuid', tenant: ADDRESS, provider_uuid: 'p1',
      connection: { host: '1.2.3.4', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
    } as never);
    const result = await executeConfirmedDeployApp(CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions(), makePayload());
    expect((result.data as { url?: string }).url).toBe('1.2.3.4:32456');
  });
});

describe('C0 characterization — failure paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('provision-fail: failed progress, updateApp(failed), "Deployment failed:" error', async () => {
    // C2 re-point: a provision failure now surfaces as a deployManifest throw
    // (ManifestMCPError) after onLeaseCreated + one provisioning tick; the
    // chain-truth check (getLease terminal) resolves it to failed.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      opts?.pollOptions?.onProgress?.({ state: LeaseState.LEASE_STATE_ACTIVE, phase: 'provisioning' } as never);
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'container crashed');
    });
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_CLOSED } as never);
    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry, onProgress }), makePayload(),
    );

    expect(result.success).toBe(false);
    // SENTINEL — expected current value: 'Deployment failed: container crashed'
    expect(result.error).toBe('Deployment failed: container crashed');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', { status: 'failed' });
    const phases = onProgress.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phases).toEqual(['creating_lease', 'uploading', 'provisioning', 'failed']);
  });

  it('create-lease reject: raw error surfaced, NO addApp (no lease exists)', async () => {
    // C2 re-point: create-lease reject = deployManifest throwing a raw Error
    // BEFORE onLeaseCreated fires (no lease, case 1 in handleDeployManifestError).
    vi.mocked(deployManifest).mockRejectedValue(new Error('insufficient funds'));
    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry, onProgress }), makePayload(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient funds');
    expect(registry.addApp).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed' }));
  });
});

describe('C0 characterization — fallbackToChainState core (delta D-B frozen half)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('poll throws but chain ACTIVE → still reports ready/running (must NOT report failed)', async () => {
    // C2 re-point: the AMBIGUOUS post-lease poll throw = deployManifest rejecting
    // with a ManifestMCPError after onLeaseCreated; classifyLeaseChainState reads
    // getLease (ACTIVE) as the source of truth → running.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll network flake');
    });
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);

    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry, onProgress }), makePayload(),
    );

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('running');
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, 'new-lease-uuid', expect.objectContaining({ status: 'running' }),
    );
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready' }));
  });

  it('poll inconclusive + chain PENDING → deploying (still-in-flight pin)', async () => {
    // C2 re-point: an inconclusive poll = deployManifest rejecting with a
    // ManifestMCPError after onLeaseCreated; getLease PENDING (still in flight)
    // → classifyLeaseChainState 'deploying'.
    vi.mocked(deployManifest).mockImplementation(async (_ctx, _spec, opts) => {
      await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'poll inconclusive');
    });
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_PENDING } as never);

    const registry = makeRegistry();
    const result = await executeConfirmedDeployApp(
      CONFIRMED_ARGS, CLIENT_MANAGER, makeOptions({ appRegistry: registry }), makePayload(),
    );

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('deploying');
    expect(registry.updateApp).toHaveBeenCalledWith(ADDRESS, 'new-lease-uuid', { status: 'deploying' });
  });
});

describe('C0 characterization — executeConfirmedBatchDeploy', () => {
  beforeEach(() => vi.clearAllMocks());

  function batchEntry(app_name: string) {
    return { app_name, size: 'micro', skuUuid: 'sku-1', providerUuid: 'p1', providerUrl: 'https://fred.example.com', payload: makePayload() };
  }

  it('pins summary shape (deployed[]/failed[]), per-entry writes, and batch progress', async () => {
    mockHappyPath();
    const onProgress = vi.fn();
    const registry = makeRegistry();
    const result = await executeConfirmedBatchDeploy(
      { entries: [batchEntry('game1'), batchEntry('game2')] },
      CLIENT_MANAGER,
      makeOptions({ appRegistry: registry, onProgress }),
    );

    expect(result.success).toBe(true);
    const data = result.data as { deployed: { name: string }[]; failed: unknown[] };
    expect(data.deployed).toHaveLength(2);
    expect(data.deployed.map((d) => d.name).sort()).toEqual(['game1', 'game2']);
    expect(data.failed).toHaveLength(0);

    // Per-entry registry writes: two addApp(deploying), two updateApp(running)
    expect(registry.addApp).toHaveBeenCalledTimes(2);
    expect(registry.updateApp).toHaveBeenCalledWith(
      ADDRESS, 'new-lease-uuid', expect.objectContaining({ status: 'running' }),
    );

    // Batch progress carries a per-app `batch` array on the final emit
    const lastProgress = onProgress.mock.calls[onProgress.mock.calls.length - 1][0] as { batch?: unknown };
    expect(lastProgress.batch).toBeDefined();
  });

  it('partial failure: one create-lease reject lands in failed[], other in deployed[]', async () => {
    // C3 re-point: the batch path now delegates to deployManifest — a raw create-lease
    // rejection is deployManifest throwing before onLeaseCreated fires (case 1).
    vi.mocked(deployManifest)
      .mockImplementationOnce(async (_c, _s, opts) => {
        await opts?.onLeaseCreated?.('new-lease-uuid', 'https://fred.example.com');
        return {
          lease_uuid: 'new-lease-uuid', provider_uuid: 'p1', provider_url: 'https://fred.example.com',
          state: LeaseState.LEASE_STATE_ACTIVE,
          connection: { host: '127.0.0.1', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } },
        } as never;
      })
      .mockRejectedValueOnce(new Error('insufficient funds'));

    const result = await executeConfirmedBatchDeploy(
      { entries: [batchEntry('game1'), batchEntry('game2')] },
      CLIENT_MANAGER,
      makeOptions(),
    );

    const data = result.data as { deployed: unknown[]; failed: unknown[] };
    expect(data.deployed).toHaveLength(1);
    expect(data.failed).toHaveLength(1);
  });
});
