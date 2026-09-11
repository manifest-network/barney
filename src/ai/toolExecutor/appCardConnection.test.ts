import { describe, expect, it, vi } from 'vitest';
import { appCardConnection } from './appCardConnection';
import { logError } from '../../utils/errors';
import type { AppEntry } from '../../registry/appRegistry';

vi.mock('../../utils/errors', () => ({ logError: vi.fn() }));

describe('appCardConnection', () => {
  it('omits invalid top-level connection data without throwing away the status result', () => {
    expect(appCardConnection({ host: 123 } as unknown as AppEntry['connection'])).toBeUndefined();
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
      host: '203.0.113.10', services: { web: {}, db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } } },
    });
  });
});
