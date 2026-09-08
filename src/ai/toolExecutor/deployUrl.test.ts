import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLeaseStatus } from '@manifest-network/manifest-sdk/deploy';
import { extractPort, formatConnectionUrl } from './helpers';
import { resolveAppUrl } from './deployUrl';
import type { SigningContext } from './types';

vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const FQDN = 'app.workloads.example.com';
const signing: SigningContext = {
  providerAuth: { providerToken: vi.fn(), leaseDataToken: vi.fn() },
  authTokens: { getAuthToken: vi.fn().mockResolvedValue('token'), getLeaseDataAuthToken: vi.fn() },
  relayAuth: { signChallenge: vi.fn() },
};

afterEach(() => vi.restoreAllMocks());

async function resolveFromWireStatus(body: Record<string, unknown>) {
  // Exercise the published SDK's wire validation, then Barney's production
  // fallback with no caller-supplied host and an unavailable connection endpoint.
  const fetchStatus = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    state: 'LEASE_STATE_ACTIVE',
    ...body,
  }), { status: 200 }));
  const status = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, 'token', fetchStatus);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unavailable', { status: 503 }));
  const result = await resolveAppUrl(PROVIDER_URL, LEASE_UUID, status, 'manifest1tenant', signing, 'test');
  return { status, result };
}

describe('provider status URL fallback', () => {
  it('uses the instance FQDN when the connection endpoint is unavailable', async () => {
    const { result } = await resolveFromWireStatus({
      instances: [{ name: 'web', status: 'running', fqdn: FQDN, ports: {
        '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 },
      } }],
    });
    expect(result).toEqual({ url: `https://${FQDN}` });
  });

  it('uses the primary stack service FQDN instead of the provider API host', async () => {
    const { result } = await resolveFromWireStatus({
      services: {
        db: { instances: [{ name: 'db', status: 'running', fqdn: 'db.example.com', ports: {
          '5432/tcp': { host_ip: '0.0.0.0', host_port: 32100 },
        } }] },
        web: { instances: [{ name: 'web', status: 'running', fqdn: FQDN, ports: {
          '80/tcp': { host_ip: '0.0.0.0', host_port: 32456 },
        } }] },
      },
    });
    expect(result).toEqual({ url: `https://${FQDN}` });
  });

  it('keeps the assigned host port for a TCP service', async () => {
    const { result } = await resolveFromWireStatus({
      instances: [{ name: 'db', status: 'running', fqdn: FQDN, ports: {
        '5432/tcp': { host_ip: '0.0.0.0', host_port: 32456 },
      } }],
    });
    expect(result).toEqual({ url: `${FQDN}:32456` });
  });

  it.each(['instance', 'stack'])('omits an unassigned %s port', async (shape) => {
    const instance = { name: 'web', status: 'running', fqdn: FQDN, ports: {
      '8080/tcp': { host_ip: '0.0.0.0', host_port: 0 },
    } };
    const { result } = await resolveFromWireStatus(shape === 'instance'
      ? { instances: [instance] }
      : { services: { web: { instances: [instance] } } });
    expect(result).toEqual({});
  });

  it('does not guess a workload address from an API host or wildcard bind address', async () => {
    const { result } = await resolveFromWireStatus({
      instances: [{ name: 'web', status: 'running', ports: {
        '8080/tcp': { host_ip: '0.0.0.0', host_port: 32456 },
      } }],
    });
    expect(result).toEqual({});
  });

  it('keeps legacy numeric wire ports subject to SDK validation', async () => {
    const { status, result } = await resolveFromWireStatus({
      instances: [{ name: 'web', status: 'running', fqdn: FQDN, ports: { '8080/tcp': 32456 } }],
    });
    expect(status.instances?.[0].ports).toEqual({});
    expect(result).toEqual({});
  });

  it('still uses valid endpoints when the SDK drops a malformed port mapping', async () => {
    const { result } = await resolveFromWireStatus({
      instances: [{ name: 'web', status: 'running', ports: { '8080/tcp': 32456 } }],
      endpoints: { '8080/tcp': `http://${FQDN}:32456` },
    });
    expect(result).toEqual({ url: `https://${FQDN}` });
  });

  it('omits an endpoint with an unassigned port', async () => {
    const { result } = await resolveFromWireStatus({ endpoints: { '8080/tcp': `http://${FQDN}:0` } });
    expect(result).toEqual({});
  });
});

describe('persisted port mapping compatibility', () => {
  it.each([
    32456,
    '32456',
    { host_ip: '0.0.0.0', host_port: 32456 },
    { HostIp: '0.0.0.0', HostPort: '32456' },
    [{ HostIp: '0.0.0.0', HostPort: '32456' }],
  ])('reads stored mapping %j', (mapping) => {
    expect(formatConnectionUrl('1.2.3.4', { host: '1.2.3.4', ports: { '8080/tcp': mapping } }))
      .toBe('1.2.3.4:32456');
  });

  it.each([0, '0', -1, 1.5, 65536, NaN, Infinity, '32456garbage', '0x80', '8e3'])('rejects unusable port %j', (port) => {
    expect(extractPort(port)).toBeUndefined();
    expect(extractPort({ host_port: port })).toBeUndefined();
    expect(formatConnectionUrl('1.2.3.4', { host: '1.2.3.4', ports: { '8080/tcp': port } }))
      .toBeUndefined();
  });
});
