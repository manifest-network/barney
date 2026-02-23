import { describe, it, expect } from 'vitest';
import { collectInstanceUrls } from './helpers';

describe('collectInstanceUrls', () => {
  it('returns empty array for undefined connection', () => {
    expect(collectInstanceUrls(undefined)).toEqual([]);
  });

  it('returns empty array for connection with no instances', () => {
    expect(collectInstanceUrls({})).toEqual([]);
  });

  it('returns empty array for single instance (no need to show extras)', () => {
    expect(collectInstanceUrls({
      instances: [{ fqdn: '0-abc1234.barney8.manifest0.net' }],
    })).toEqual([]);
  });

  it('returns URLs for flat multi-instance lease', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        { fqdn: '1-def5678.barney8.manifest0.net' },
      ],
    });
    expect(result).toEqual([
      'https://0-abc1234.barney8.manifest0.net',
      'https://1-def5678.barney8.manifest0.net',
    ]);
  });

  it('returns URLs for stack multi-instance lease', () => {
    const result = collectInstanceUrls({
      services: {
        web: {
          instances: [
            { fqdn: 'web-0-abc1234.barney8.manifest0.net' },
            { fqdn: 'web-1-def5678.barney8.manifest0.net' },
          ],
        },
      },
    });
    expect(result).toEqual([
      'https://web-0-abc1234.barney8.manifest0.net',
      'https://web-1-def5678.barney8.manifest0.net',
    ]);
  });

  it('returns empty array when instances have no fqdn', () => {
    expect(collectInstanceUrls({
      instances: [
        { fqdn: undefined },
        { fqdn: undefined },
      ],
    })).toEqual([]);
  });

  it('skips instances without fqdn in mixed array', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        {},
        { fqdn: '2-ghi9012.barney8.manifest0.net' },
      ],
    });
    expect(result).toEqual([
      'https://0-abc1234.barney8.manifest0.net',
      'https://2-ghi9012.barney8.manifest0.net',
    ]);
  });

  it('deduplicates identical FQDNs', () => {
    expect(collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
        { fqdn: '0-abc1234.barney8.manifest0.net' },
      ],
    })).toEqual([]);
  });

  it('collects from both flat instances and services', () => {
    const result = collectInstanceUrls({
      instances: [
        { fqdn: '0-abc1234.barney8.manifest0.net' },
      ],
      services: {
        web: {
          instances: [
            { fqdn: 'web-0-def5678.barney8.manifest0.net' },
          ],
        },
      },
    });
    expect(result).toEqual([
      'https://0-abc1234.barney8.manifest0.net',
      'https://web-0-def5678.barney8.manifest0.net',
    ]);
  });
});
