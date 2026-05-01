import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

vi.mock('../../hooks/useVisibilityPolling', () => ({
  useVisibilityPolling: vi.fn(),
}));

const sendMessage = vi.fn();

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ sendMessage }),
}));

vi.mock('../../utils/customDomainStatus', () => ({
  resolveDnsViaDoh: vi.fn(),
  probeHttps: vi.fn(),
  computeStatus: vi.fn(),
}));

import { CustomDomainCard } from './CustomDomainCard';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling';
import { computeStatus, resolveDnsViaDoh, probeHttps } from '../../utils/customDomainStatus';
import type { CustomDomainCardData } from '../../contexts/aiTypes';

function makeData(overrides: Partial<CustomDomainCardData> = {}): CustomDomainCardData {
  return {
    appName: 'my-api',
    fqdn: 'app.example.com',
    leaseUuid: 'lease-1',
    serviceName: '',
    expectedCnameTarget: 'auto.barney0.manifest0.net',
    expectedAddress: 'manifest1tenant',
    ...overrides,
  };
}

describe('CustomDomainCard', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => { root.unmount(); });
    container.remove();
  });

  it('renders fqdn and expected CNAME target', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('app.example.com');
    expect(text).toContain('auto.barney0.manifest0.net');
  });

  it('renders pending_dns status by default', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Pending DNS/i);
  });

  it('subscribes to useVisibilityPolling at 30s', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(useVisibilityPolling).toHaveBeenCalled();
    const args = vi.mocked(useVisibilityPolling).mock.calls[0];
    expect(args[1]).toBe(30_000);
  });

  it('shows service name when present', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ serviceName: 'web' }) }));
    });
    expect(container.textContent ?? '').toMatch(/Service:.*web/);
  });

  it('Change button dispatches AI sendMessage with appName', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ appName: 'my-api' }) }));
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Change');
    expect(buttons.length).toBe(1);
    flushSync(() => { buttons[0].click(); });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/change.*my-api/i));
  });

  it('Remove button dispatches AI sendMessage with appName and service', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ appName: 'wp', serviceName: 'web' }) }));
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Remove');
    flushSync(() => { buttons[0].click(); });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/remove.*wp.*web/i));
  });

  it('transitions through statuses based on poll callback result', async () => {
    let pollFn: () => Promise<unknown> = async () => undefined;
    vi.mocked(useVisibilityPolling).mockImplementation((cb) => {
      pollFn = cb;
    });

    vi.mocked(resolveDnsViaDoh).mockResolvedValue({ result: 'ok', cname: 'auto.barney0.manifest0.net' });
    vi.mocked(probeHttps).mockResolvedValue({ result: 'unreachable' });
    vi.mocked(computeStatus).mockReturnValue('issuing_cert');

    await act(async () => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });

    await act(async () => { await pollFn(); });
    expect(container.textContent).toMatch(/Issuing certificate/i);

    // Now active
    vi.mocked(probeHttps).mockResolvedValue({ result: 'ok' });
    vi.mocked(computeStatus).mockReturnValue('active');
    await act(async () => { await pollFn(); });
    expect(container.textContent).toMatch(/Active/i);
  });
});
