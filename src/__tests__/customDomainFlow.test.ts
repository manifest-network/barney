/**
 * Integration test: end-to-end custom-domain attach flow.
 *
 * Validates that the two halves of the feature — executor (AI tool flow)
 * and UI (CustomDomainCard) — agree on the `displayCard` shape and that
 * the card's status-pill renders the four states driven by the shared
 * `dnsStatuses` slice. Unit-level edges (validation, multi-item legacy
 * rejection, uniqueness, etc.) live in `setCustomDomain.test.ts` — this
 * file is the happy-path glue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

// --- Mocks --------------------------------------------------------------

const sendMessage = vi.fn();
// Mutable so the UI portion of the test can swap entries between renders to
// exercise pending_dns → issuing_cert → active. Reset in beforeEach.
let dnsStatuses: Map<string, { kind: string; expectedCnameTarget?: string; detail?: string }> = new Map();

vi.mock('../hooks/useAI', () => ({
  useAI: () => ({ sendMessage, dnsStatuses }),
}));

vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/deploy')>()),
  setItemCustomDomain: vi.fn(),
}));

vi.mock('@manifest-network/manifest-sdk/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/chain')>()),
  cosmosTx: vi.fn(),
}));

vi.mock('../api/leaseItems', () => ({ getLeaseItemsForLease: vi.fn() }));
vi.mock('../api/leaseByCustomDomain', () => ({ queryLeaseByCustomDomain: vi.fn() }));
vi.mock('../api/billingParams', () => ({
  getReservedDomainSuffixes: vi.fn().mockResolvedValue([]),
  invalidateReservedDomainSuffixesCache: vi.fn(),
}));
vi.mock('../utils/errors', () => ({ logError: vi.fn() }));

import { executeTool, executeConfirmedTool } from '../ai/toolExecutor';
import { makeRegistry } from '../ai/toolExecutor/testHelpers';
import { setItemCustomDomain } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseItemsForLease } from '../api/leaseItems';
import { queryLeaseByCustomDomain } from '../api/leaseByCustomDomain';
import { CustomDomainCard } from '../components/ai/CustomDomainCard';
import { dnsStatusKey } from '../stores/aiStore';
import type { AppEntry } from '../registry/appRegistry';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';
import type { CustomDomainCardData } from '../contexts/aiTypes';

// --- Fixtures -----------------------------------------------------------

const ADDR = 'manifest1tenant';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const FQDN = 'app.example.com';
const EXPECTED_CNAME = 'auto.barney0.manifest0.net';
const CLIENT_MANAGER = {} as CosmosClientManager;

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: LEASE_UUID,
    size: 'micro',
    providerUuid: 'prov-1',
    providerUrl: 'https://prov.example',
    createdAt: 1,
    status: 'running',
    connection: { host: 'prov.example', fqdn: EXPECTED_CNAME },
    ...overrides,
  };
}

// --- Tests --------------------------------------------------------------

describe('customDomainFlow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnsStatuses = new Map();
  });

  it('executor path: tool call → confirmation → confirmed call updates registry and emits displayCard', async () => {
    const app = makeApp();
    const registry = makeRegistry([app]);
    const options = {
      clientManager: CLIENT_MANAGER,
      address: ADDR,
      appRegistry: registry,
      tiers: [],
      authorization: {
        originAddress: ADDR,
        chainId: 'manifest-test',
        clientGeneration: 1,
        signerGeneration: 1,
      },
      assertAuthorization: vi.fn(),
    };

    // Chain reports a single legacy (unnamed) lease item with no current domain.
    vi.mocked(getLeaseItemsForLease).mockResolvedValue([
      { skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' }, serviceName: '', customDomain: '' } as any,
    ]);
    // Uniqueness pre-check passes — domain not yet attached anywhere.
    vi.mocked(queryLeaseByCustomDomain).mockResolvedValue(null);

    // Step 1: tool call → confirmation requested.
    const preConfirm = await executeTool(
      'set_custom_domain',
      { app_name: 'my-app', custom_domain: FQDN },
      options,
    );
    expect(preConfirm.success).toBe(true);
    if (!preConfirm.success || !preConfirm.requiresConfirmation) {
      throw new Error('expected requiresConfirmation');
    }
    expect(preConfirm.pendingAction.toolName).toBe('set_custom_domain');
    const pendingArgs = preConfirm.pendingAction.args;
    expect(pendingArgs.leaseUuid).toBe(LEASE_UUID);
    expect(pendingArgs.serviceName).toBe('');
    expect(pendingArgs.customDomain).toBe(FQDN);
    expect(pendingArgs.expectedCnameTarget).toBe(EXPECTED_CNAME);

    // Step 2: confirmed call → mono broadcast succeeds → displayCard emitted.
    vi.mocked(setItemCustomDomain).mockResolvedValue({
      lease_uuid: LEASE_UUID,
      service_name: '',
      custom_domain: FQDN,
      transactionHash: 'tx-set-1',
      code: 0,
    } as any);

    const confirmed = await executeConfirmedTool(
      'set_custom_domain',
      pendingArgs,
      options,
    );
    expect(confirmed.success).toBe(true);
    if (!confirmed.success || confirmed.requiresConfirmation) {
      throw new Error('expected non-confirmation success');
    }
    expect(confirmed.displayCard?.type).toBe('custom_domain');
    if (confirmed.displayCard?.type !== 'custom_domain') return; // type narrow
    expect(confirmed.displayCard.data.fqdn).toBe(FQDN);
    expect(confirmed.displayCard.data.leaseUuid).toBe(LEASE_UUID);
    expect(confirmed.displayCard.data.serviceName).toBe('');
    expect(confirmed.displayCard.data.expectedCnameTarget).toBe(EXPECTED_CNAME);
    expect(confirmed.displayCard.data.appName).toBe('my-app');

    // Step 3: registry's customDomains cache populated for the polling driver.
    const stored = registry.getAppByLease(ADDR, LEASE_UUID);
    expect(stored?.customDomains).toEqual([
      { serviceName: '', customDomain: FQDN },
    ]);
  });

  it('UI path: CustomDomainCard reflects pending_dns → issuing_cert → active as dnsStatuses slice mutates', () => {
    // Use the exact displayCard.data shape the executor returns above so any
    // drift between the two halves breaks loudly.
    const data: CustomDomainCardData = {
      appName: 'my-app',
      fqdn: FQDN,
      leaseUuid: LEASE_UUID,
      serviceName: '',
      expectedCnameTarget: EXPECTED_CNAME,
      expectedAddress: ADDR,
    };
    const key = dnsStatusKey(LEASE_UUID, FQDN);

    let container: HTMLDivElement | null = null;
    let root: Root | null = null;
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      // CustomDomainCard is memo()-wrapped; a same-reference `data` prop
      // would short-circuit re-renders. Spread it each render so React
      // sees a fresh prop reference and re-reads the (mocked) useAI slice.

      // Initial: empty slice. Card defaults to pending_dns per the
      // `report?.kind ?? 'pending_dns'` fallback in ActiveDomainView.
      flushSync(() => { root!.render(createElement(CustomDomainCard, { data: { ...data } })); });
      expect(container.textContent).toContain('Pending DNS');

      // Transition: issuing_cert.
      dnsStatuses = new Map([[key, { kind: 'issuing_cert', expectedCnameTarget: EXPECTED_CNAME }]]);
      flushSync(() => { root!.render(createElement(CustomDomainCard, { data: { ...data } })); });
      expect(container.textContent).toContain('Issuing certificate');

      // Transition: active.
      dnsStatuses = new Map([[key, { kind: 'active', expectedCnameTarget: EXPECTED_CNAME }]]);
      flushSync(() => { root!.render(createElement(CustomDomainCard, { data: { ...data } })); });
      expect(container.textContent).toContain('Active');

      // Transition: failed (covers the fourth status branch end-to-end).
      dnsStatuses = new Map([[key, { kind: 'failed', expectedCnameTarget: EXPECTED_CNAME }]]);
      flushSync(() => { root!.render(createElement(CustomDomainCard, { data: { ...data } })); });
      expect(container.textContent).toContain('Failed');
    } finally {
      if (root) flushSync(() => { root!.unmount(); });
      if (container) container.remove();
    }
  });
});
