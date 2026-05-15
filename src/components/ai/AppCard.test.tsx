import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

const sendMessage = vi.fn();
const requestStopApp = vi.fn();
let dnsStatuses: Map<string, { kind: string; expectedCnameTarget?: string; detail?: string }> = new Map();

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ sendMessage, dnsStatuses, requestStopApp }),
}));

import { AppCard } from './AppCard';
import type { AppCardData } from '../../contexts/aiTypes';

let container: HTMLDivElement;
let root: Root;

function makeData(overrides: Partial<AppCardData> = {}): AppCardData {
  return {
    name: 'my-app',
    status: 'running',
    ...overrides,
  };
}

function render(data: AppCardData) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root.render(createElement(AppCard, { data })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  dnsStatuses = new Map();
});

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

describe('AppCard', () => {
  it('renders the app name and status', () => {
    render(makeData());
    expect(container.textContent).toContain('my-app');
    expect(container.textContent).toContain('running');
  });

  it('accepts url and connection props', () => {
    render(makeData({
      url: 'https://example.com',
      connection: {
        host: '1.2.3.4',
        fqdn: 'abc123.barney8.manifest0.net',
        ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32000 } },
      },
    }));
    expect(container.textContent).toContain('https://example.com');
  });

  it('renders instance endpoints as plain text for multi-instance FQDNs', () => {
    render(makeData({
      url: 'abc123.barney8.manifest0.net',
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: '0-abc123.barney8.manifest0.net' },
          { fqdn: '1-def456.barney8.manifest0.net' },
        ],
      },
    }));
    const items = container.querySelectorAll('.app-card__instance-link');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('0-abc123.barney8.manifest0.net');
    expect(items[1].textContent).toBe('1-def456.barney8.manifest0.net');
    expect(items[0].tagName).toBe('SPAN');
    expect(items[1].tagName).toBe('SPAN');
  });

  it('renders no instance links for a single-instance deployment', () => {
    render(makeData({
      connection: {
        host: '1.2.3.4',
        instances: [{ fqdn: '0-abc123.barney8.manifest0.net' }],
      },
    }));
    expect(container.querySelectorAll('.app-card__instance-link')).toHaveLength(0);
  });

  it('renders no instance links when FQDNs are malicious', () => {
    render(makeData({
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: 'javascript:alert(1)' },
          { fqdn: 'evil.com/phish' },
        ],
      },
    }));
    expect(container.querySelectorAll('.app-card__instance-link')).toHaveLength(0);
    expect(container.querySelector('.app-card__instances')).toBeNull();
  });

  it('renders only valid instance endpoints when mixed with invalid FQDNs', () => {
    render(makeData({
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: '0-abc123.barney8.manifest0.net' },
          { fqdn: 'javascript:alert(1)' },
          { fqdn: '1-def456.barney8.manifest0.net' },
        ],
      },
    }));
    const items = container.querySelectorAll('.app-card__instance-link');
    expect(items).toHaveLength(2);
  });

  it('renders stack service instance endpoints from services map', () => {
    render(makeData({
      name: 'wp-stack',
      connection: {
        host: '1.2.3.4',
        services: {
          web: {
            instances: [
              { fqdn: 'web-0.barney8.manifest0.net', ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32000 } } },
              { fqdn: 'web-1.barney8.manifest0.net', ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32001 } } },
            ],
          },
        },
      },
    }));
    const items = container.querySelectorAll('.app-card__instance-link');
    expect(items).toHaveLength(2);
  });

  describe('handleStop', () => {
    // RED-THEN-GREEN: with the pre-fix production code (sendMessage(`Stop ${name}`)),
    // these tests FAIL — sendMessage is called with 'Stop all' but requestStopApp
    // isn't. After the fix, sendMessage is NOT called and requestStopApp IS called
    // with the literal app name. App names matching stop_app's bulk-stop sentinel
    // (`"all"`) used to trigger the model's bulk-stop intent via NL routing;
    // the direct action bypasses the model entirely. See PR #93 Copilot 3244138206.
    it('routes Stop through requestStopApp with the literal name when the app is named "all"', () => {
      render(makeData({ name: 'all' }));
      const stop = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Stop'));
      expect(stop).toBeDefined();
      flushSync(() => { stop!.click(); });

      expect(requestStopApp).toHaveBeenCalledTimes(1);
      expect(requestStopApp).toHaveBeenCalledWith('all');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('routes Stop through requestStopApp for a non-sentinel name (no regression)', () => {
      render(makeData({ name: 'redis' }));
      const stop = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Stop'));
      expect(stop).toBeDefined();
      flushSync(() => { stop!.click(); });

      expect(requestStopApp).toHaveBeenCalledWith('redis');
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('embedded custom-domain row', () => {
    it('does not render the domain section when customDomain is unset', () => {
      render(makeData());
      expect(container.querySelector('.app-card__domain')).toBeNull();
    });

    it('renders a DomainRow with status from the slice', () => {
      dnsStatuses = new Map([
        ['lease-1::app.example.com', { kind: 'active', expectedCnameTarget: 'auto.barney0.manifest0.net' }],
      ]);
      render(makeData({
        customDomain: {
          fqdn: 'app.example.com',
          leaseUuid: 'lease-1',
          serviceName: '',
          expectedCnameTarget: 'auto.barney0.manifest0.net',
          isApex: false,
        },
      }));
      expect(container.textContent).toContain('app.example.com');
      expect(container.textContent).toMatch(/Active/);
    });

    it('falls back to data.expectedCnameTarget when the slice is empty', () => {
      render(makeData({
        customDomain: {
          fqdn: 'app.example.com',
          leaseUuid: 'lease-1',
          serviceName: '',
          expectedCnameTarget: 'fallback.target.host',
          isApex: false,
        },
      }));
      expect(container.textContent).toContain('fallback.target.host');
      expect(container.textContent).toMatch(/Pending DNS/);
    });

    it('renders the apex warning when isApex=true', () => {
      render(makeData({
        customDomain: {
          fqdn: 'example.com',
          leaseUuid: 'lease-1',
          serviceName: '',
          isApex: true,
        },
      }));
      expect(container.textContent).toMatch(/Apex domain/);
      expect(container.textContent).toMatch(/ALIAS/);
    });
  });
});
