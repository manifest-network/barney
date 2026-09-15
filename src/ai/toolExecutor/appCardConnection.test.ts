import { describe, expect, it, vi } from 'vitest';
import { appCardConnection } from './appCardConnection';
import { logError } from '../../utils/errors';
import type { AppEntry } from '../../registry/appRegistry';

vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

describe('appCardConnection', () => {
  it('omits an invalid host while retaining independently usable endpoints without repetitive errors', () => {
    vi.mocked(logError).mockClear();
    expect(appCardConnection({ host: 123, fqdn: 'web.example.com', ports: { '80/tcp': { host_ip: '203.0.113.10', host_port: 32000 } } } as unknown as AppEntry['connection']))
      .toEqual({ host: undefined, fqdn: 'web.example.com', ports: { '80/tcp': { host_ip: '203.0.113.10', host_port: 32000 } } });
    expect(logError).not.toHaveBeenCalled();
  });

  it('omits a malformed root connection without throwing away the status result', () => {
    expect(appCardConnection('invalid' as unknown as AppEntry['connection'])).toBeUndefined();
    expect(logError).toHaveBeenCalledWith('appCardConnection', expect.any(Error));
  });

  it('retains valid nested access details while dropping malformed entries', () => {
    expect(appCardConnection({
      host: '203.0.113.10',
      services: {
        web: null,
        db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 }, invalid: { host_ip: null, host_port: -1 } } },
      },
    })).toEqual({
      host: '203.0.113.10', services: { db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } } },
    });
  });

  it('distinguishes explicitly empty inventories from mappings rejected by validation', () => {
    expect(appCardConnection({ host: '203.0.113.10', services: {
      internal: { ports: {} },
      invalid: { ports: { '80/tcp': { host_port: -1 } } },
    } })?.services).toEqual({ internal: { ports: {} }, invalid: { ports: undefined } });
  });
});
