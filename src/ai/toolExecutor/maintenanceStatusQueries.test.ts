import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import type { AppEntry } from '../../registry/appRegistry';
import type { ToolExecutorOptions } from './types';
import { makeRegistry } from './testHelpers';

// Keep app_status, its capability context, and protocol parsing real. Only
// chain/provider I/O is controlled, so silent context-construction failures fail.
vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));
vi.mock('../../api/providerFetchAdapter', () => ({ providerFetch: vi.fn() }));
vi.mock('../../api/fred', () => ({ getLeaseProvision: vi.fn(), getLeaseReleases: vi.fn(), getLeaseLogs: vi.fn() }));

const originalConfig = window.__RUNTIME_CONFIG__;
const address = 'manifest1tenant';
const app: AppEntry = {
  name: 'my-app', leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
  providerUuid: '660e8400-e29b-41d4-a716-446655440000', providerUrl: 'https://provider.example',
  size: 'small', createdAt: 1, status: 'running', chainState: 'active', provisionState: 'confirmed',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  window.__RUNTIME_CONFIG__ = originalConfig;
});
afterEach(() => { window.__RUNTIME_CONFIG__ = originalConfig; });

async function setup(status = 'ready', accepted?: boolean, badConfig?: string) {
  if (badConfig) window.__RUNTIME_CONFIG__ = { ...originalConfig, PUBLIC_FRED_COMPATIBILITY: badConfig };
  const { getReadClient } = await import('../../api/readClient');
  const { providerFetch } = await import('../../api/providerFetchAdapter');
  const fred = await import('../../api/fred');
  const lease = vi.fn().mockResolvedValue({ lease: { uuid: app.leaseUuid, state: 2, providerUuid: app.providerUuid, items: [] } });
  const provider = vi.fn().mockResolvedValue({ provider: { apiUrl: app.providerUrl } });
  vi.mocked(getReadClient).mockResolvedValue({ query: { liftedinit: { billing: { v1: { lease } }, sku: { v1: { provider } } } } } as never);
  vi.mocked(providerFetch).mockImplementation(async (input) => {
    const url = String(input);
    const response = url.endsWith('/status')
      ? { state: 'LEASE_STATE_ACTIVE', provision_status: status }
      : { lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid, connection: { host: 'app.example' } };
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const releases = { lease_uuid: app.leaseUuid, tenant: address, provider_uuid: app.providerUuid,
    releases: [{ version: 1, image: 'nginx', status: 'active', created_at: '2026-09-23T12:00:00Z' }] };
  vi.mocked(fred.getLeaseProvision).mockResolvedValue({ status, fail_count: 0 });
  vi.mocked(fred.getLeaseReleases).mockResolvedValue(releases);
  const providerToken = vi.fn().mockResolvedValue('status-auth');
  const getAuthToken = vi.fn().mockResolvedValue('reconciliation-auth');
  const options: ToolExecutorOptions = {
    address, clientManager: {} as CosmosClientManager, appRegistry: makeRegistry([{ ...app }]), tiers: [],
    signing: { providerAuth: { providerToken }, authTokens: { getAuthToken } } as unknown as ToolExecutorOptions['signing'],
  };
  const operations = await import('./maintenanceOperation');
  if (accepted !== undefined) {
    const command = await operations.getOrCreateMaintenanceOperation({ address, providerUrl: app.providerUrl, leaseUuid: app.leaseUuid,
      operation: 'restart', baselineReleaseVersions: [1] });
    await operations.markMaintenanceOperationDispatched(command);
    if (accepted) await operations.markMaintenanceOperationAccepted(command);
  }
  return { options, lease, fred, providerToken, getAuthToken, operations, providerFetch, queries: await import('./compositeQueries') };
}

describe('maintenance status query integration', () => {
  it.each(['PR240', '{"provider.example":"pr240"}'])('still reads authoritative status with invalid mutation compatibility %s', async (config) => {
    const { options, queries, lease, providerFetch } = await setup('ready', undefined, config);
    const result = await queries.executeAppStatus({ app_name: app.name }, options);
    expect(result).toMatchObject({ success: true, data: { chainState: 'active', provision_status: 'ready', statusUnavailable: false, status: 'running' } });
    expect(lease).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const { buildBarneyCtx } = await import('./capabilityCtx');
    await expect(buildBarneyCtx(options.clientManager!, options.signing!)).rejects.toThrow('PUBLIC_FRED_COMPATIBILITY');
  });

  it.each(['restarting', 'updating', 'provisioning', 'unknown'])('keeps the confirmed app running through both %s observation paths', async (status) => {
    const { options, queries, fred } = await setup(status, true);
    const result = await queries.executeAppStatus({ app_name: app.name }, options);
    expect(result).toMatchObject({ success: true, data: { provision_status: status, status: 'running', maintenance: { outcome: 'unconfirmed' } } });
    expect(options.appRegistry!.getAppByLease(address, app.leaseUuid)?.provisionState).toBe('confirmed');
    expect(fred.getLeaseProvision).toHaveBeenCalledTimes(1);
  });

  it('does not add signatures or provider reads for unaccepted status reconciliation', async () => {
    const { options, queries, fred, providerToken, getAuthToken, operations } = await setup('ready', false);
    const result = await queries.executeAppStatus({ app_name: app.name }, options);
    expect(result).toMatchObject({ success: true, data: { status: 'running', maintenance: { outcome: 'unconfirmed', runtimeReady: true } } });
    expect(providerToken).toHaveBeenCalledTimes(2); // Normal SDK status and connection authentication.
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
    expect(fred.getLeaseReleases).not.toHaveBeenCalled();
    expect(operations.getPendingMaintenanceOperation(address, app.providerUrl, app.leaseUuid)).toBeDefined();
  });

  it('app_releases performs only the requested history read for an unaccepted command', async () => {
    const { options, queries, fred, getAuthToken } = await setup('ready', false);
    expect(await queries.executeAppReleases({ app_name: app.name }, options)).toMatchObject({
      success: true, data: { maintenance: { outcome: 'unconfirmed' } },
    });
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(fred.getLeaseReleases).toHaveBeenCalledTimes(1);
    expect(fred.getLeaseProvision).not.toHaveBeenCalled();
  });
});
