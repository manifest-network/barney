import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeConfirmedDeployApp,
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
vi.mock('../../utils/errors', async (orig) => {
  const actual = await orig<typeof import('../../utils/errors')>();
  return { ...actual, logError: vi.fn() };
});
vi.mock('./utils', () => ({
  extractLeaseUuidFromTxResult: vi.fn().mockReturnValue('new-lease-uuid'),
  uploadPayloadToProvider: vi.fn().mockResolvedValue({ success: true, data: { message: 'ok' } }),
  computePayloadHash: vi.fn(),
}));
vi.mock('../../registry/appRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry/appRegistry')>();
  return { ...actual, validateAppName: vi.fn().mockReturnValue(null) };
});
vi.mock('../../api/leaseByCustomDomain', () => ({
  queryLeaseByCustomDomain: vi.fn().mockResolvedValue(null),
}));

import { getLeaseConnectionInfo } from '../../api/provider-api';
import { waitForLeaseReady } from '../../api/fred';
import { cosmosTx } from '@manifest-network/manifest-mcp-core';

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
  vi.mocked(cosmosTx).mockResolvedValue({ code: 0, transactionHash: 'hash', rawLog: '' } as never);
  vi.mocked(waitForLeaseReady).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE });
  vi.mocked(getLeaseConnectionInfo).mockResolvedValue({
    lease_uuid: 'new-lease-uuid',
    tenant: ADDRESS,
    provider_uuid: 'p1',
    connection: {
      host: '127.0.0.1',
      instances: [{ instance_index: 0, container_id: 'abc', image: 'test', status: 'running', ports: { '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 } } }],
    },
  } as never);
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
