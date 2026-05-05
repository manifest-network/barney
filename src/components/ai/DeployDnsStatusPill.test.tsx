import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

let dnsStatuses: Map<string, { kind: string; expectedCnameTarget?: string }> = new Map();

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ dnsStatuses }),
}));

import { DeployDnsStatusPill } from './DeployDnsStatusPill';
import type { DeployDnsStatusCardData } from '../../contexts/aiTypes';

function makeData(overrides: Partial<DeployDnsStatusCardData> = {}): DeployDnsStatusCardData {
  return {
    appName: 'my-app',
    fqdn: 'app.example.com',
    leaseUuid: 'lease-1',
    serviceName: '',
    expectedCnameTarget: 'auto.barney0.manifest0.net',
    isApex: false,
    ...overrides,
  };
}

describe('DeployDnsStatusPill', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    dnsStatuses = new Map();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => { root.unmount(); });
    container.remove();
  });

  it('renders pending_dns by default when no status entry exists', () => {
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Pending DNS/);
    expect(container.textContent).toContain('app.example.com');
  });

  it('reflects the status from the shared dnsStatuses slice', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'active', expectedCnameTarget: 'auto.barney0.manifest0.net' }],
    ]);
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Active/);
  });

  it('falls back to the data.expectedCnameTarget when the slice has no target', () => {
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData() }));
    });
    expect(container.textContent).toContain('auto.barney0.manifest0.net');
  });

  it('renders an apex warning when isApex=true', () => {
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData({ isApex: true }) }));
    });
    expect(container.textContent).toMatch(/Apex domain/);
    expect(container.textContent).toMatch(/ALIAS/);
  });

  it('omits the apex warning when isApex=false', () => {
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData({ isApex: false }) }));
    });
    expect(container.textContent).not.toMatch(/Apex domain/);
  });

  it('passes the service name through to the row when set', () => {
    flushSync(() => {
      root.render(createElement(DeployDnsStatusPill, { data: makeData({ serviceName: 'web' }) }));
    });
    expect(container.textContent).toMatch(/web/);
  });
});
