import { describe, it, expect } from 'vitest';
import {
  getDomainAssignments,
  getDomainCount,
  getDomainForService,
} from './leaseDomains';
import type { LeaseItem } from './billing';

function item(overrides: Partial<LeaseItem>): LeaseItem {
  return {
    skuUuid: 'sku-x',
    quantity: 1n,
    lockedPrice: { amount: '1', denom: 'upwr' },
    serviceName: '',
    customDomain: '',
    ...overrides,
  } as LeaseItem;
}

describe('getDomainAssignments', () => {
  it('returns [] when items is null/undefined', () => {
    expect(getDomainAssignments(null)).toEqual([]);
    expect(getDomainAssignments(undefined)).toEqual([]);
  });

  it('returns [] when no items have a custom domain', () => {
    expect(
      getDomainAssignments([
        item({ serviceName: 'web', customDomain: '' }),
        item({ serviceName: 'db', customDomain: '' }),
      ]),
    ).toEqual([]);
  });

  it('returns one assignment for legacy single-item lease with a domain', () => {
    expect(
      getDomainAssignments([
        item({ serviceName: '', customDomain: 'app.example.com' }),
      ]),
    ).toEqual([{ serviceName: '', customDomain: 'app.example.com' }]);
  });

  it('returns N assignments for a multi-domain stack (forward-compat)', () => {
    expect(
      getDomainAssignments([
        item({ serviceName: 'web', customDomain: 'web.example.com' }),
        item({ serviceName: 'db', customDomain: '' }),
        item({ serviceName: 'api', customDomain: 'api.example.com' }),
      ]),
    ).toEqual([
      { serviceName: 'web', customDomain: 'web.example.com' },
      { serviceName: 'api', customDomain: 'api.example.com' },
    ]);
  });

  it('skips items with non-string customDomain (defensive)', () => {
    expect(
      getDomainAssignments([
        item({ serviceName: 'web', customDomain: undefined as unknown as string }),
        item({ serviceName: 'db', customDomain: 'db.example.com' }),
      ]),
    ).toEqual([{ serviceName: 'db', customDomain: 'db.example.com' }]);
  });
});

describe('getDomainCount', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(getDomainCount(null)).toBe(0);
    expect(getDomainCount([])).toBe(0);
  });

  it('counts only items with a non-empty customDomain', () => {
    expect(
      getDomainCount([
        item({ serviceName: 'web', customDomain: 'a.example.com' }),
        item({ serviceName: 'db', customDomain: '' }),
        item({ serviceName: 'api', customDomain: 'b.example.com' }),
      ]),
    ).toBe(2);
  });
});

describe('getDomainForService', () => {
  it('returns "" when items is null/undefined', () => {
    expect(getDomainForService(null, 'web')).toBe('');
  });

  it('returns "" when service is not found', () => {
    expect(
      getDomainForService(
        [item({ serviceName: 'web', customDomain: 'a.example.com' })],
        'db',
      ),
    ).toBe('');
  });

  it('returns "" when service exists but has no domain', () => {
    expect(
      getDomainForService(
        [item({ serviceName: 'web', customDomain: '' })],
        'web',
      ),
    ).toBe('');
  });

  it('returns the matching domain', () => {
    expect(
      getDomainForService(
        [
          item({ serviceName: 'web', customDomain: 'web.example.com' }),
          item({ serviceName: 'db', customDomain: 'db.example.com' }),
        ],
        'db',
      ),
    ).toBe('db.example.com');
  });

  it('matches the legacy empty service name', () => {
    expect(
      getDomainForService(
        [item({ serviceName: '', customDomain: 'legacy.example.com' })],
        '',
      ),
    ).toBe('legacy.example.com');
  });
});
