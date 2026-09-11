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
import { deriveUrlFromConnection } from '../../ai/toolExecutor/helpers';
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
  vi.restoreAllMocks();
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

  describe('URL-row copy', () => {
    it.each<{
      scenario: string;
      url: string;
      connection?: AppCardData['connection'];
    }>([
      {
        scenario: 'top-level bind ports',
        url: 'https://app.example.com:8443/app/start?mode=demo#ready',
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
        },
      },
      {
        scenario: 'multi-service bind ports',
        url: 'https://web.example.com:8443/dashboard?tab=apps#status',
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
          services: {
            db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } },
            web: { ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
          },
        },
      },
      {
        scenario: 'service instance bind ports',
        url: 'https://web.example.com:8443/app',
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
          services: {
            web: {
              instances: [{ ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } }],
            },
          },
        },
      },
      {
        scenario: 'an endpoint without a scheme',
        url: 'db.example.com:32001',
        connection: {
          host: '203.0.113.10',
          ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } },
        },
      },
      {
        scenario: 'a non-HTTP scheme',
        url: 'redis://cache.example.com:32002/0',
        connection: {
          host: '203.0.113.10',
          services: {
            cache: { ports: { '6379/tcp': { host_ip: '0.0.0.0', host_port: 32002 } } },
          },
        },
      },
      {
        scenario: 'no connection metadata',
        url: 'http://app.example.com:8080/health',
      },
    ])('copies the exact displayed endpoint and shows success with $scenario', async ({ url, connection }) => {
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      render(makeData({ url, connection }));
      const displayedEndpoint = container.querySelector('.app-card__url .app-card__link');
      const copyButton = container.querySelector<HTMLButtonElement>('.app-card__url button[aria-label="Copy endpoint"]');
      expect(displayedEndpoint?.textContent).toBe(url);
      expect(copyButton).not.toBeNull();

      flushSync(() => { copyButton!.click(); });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(displayedEndpoint!.textContent);
      await vi.waitFor(() => {
        expect(copyButton!.getAttribute('aria-label')).toBe('Copied');
      });
    });

    it('omits the URL row and copy button when no endpoint is displayed', () => {
      render(makeData({
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
        },
      }));

      expect(container.querySelector('.app-card__url')).toBeNull();
      expect(container.querySelector('button[aria-label="Copy endpoint"]')).toBeNull();
    });
  });

  describe('port rows', () => {
    it.each(['0.0.0.0', '::'])('uses the reported connection host for top-level %s bindings', (hostIp) => {
      render(makeData({
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: hostIp, host_port: 32000 } },
        },
      }));

      expect(container.querySelector('.app-card__port')?.textContent).toBe('80/tcp → 203.0.113.10:32000');
    });

    it.each(['0.0.0.0', '::'])('uses the reported connection host for service %s bindings', (hostIp) => {
      render(makeData({
        connection: {
          host: '2001:db8::10',
          services: {
            db: { ports: { '5432/tcp': { host_ip: hostIp, host_port: 32001 } } },
          },
        },
      }));

      expect(container.querySelector('.app-card__service-name')?.textContent).toBe('db');
      expect(container.querySelector('.app-card__port')?.textContent).toBe('5432/tcp → [2001:db8::10]:32001');
    });

    it('falls back to instance ports when the service port map is empty', () => {
      render(makeData({
        connection: {
          host: '203.0.113.10',
          services: {
            web: {
              ports: {},
              instances: [{ ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } }],
            },
          },
        },
      }));

      expect(container.querySelectorAll('.app-card__port')).toHaveLength(1);
      expect(container.querySelector('.app-card__service-name')?.textContent).toBe('web');
      expect(container.querySelector('.app-card__port')?.textContent).toBe('80/tcp → 203.0.113.10:32000');
    });

    it('renders every service once after deploy URL shaping promotes the primary ports', async () => {
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      const webPorts = { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } };
      const shaped = deriveUrlFromConnection({
        host: '203.0.113.10',
        services: {
          web: { fqdn: 'web.example.com', ports: webPorts },
          db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } },
        },
      });
      expect(shaped?.connection.ports).toEqual(webPorts);
      // Deploy-success cards snapshot the SDK's readonly connection as JSON.
      const cardData: Partial<AppCardData> = JSON.parse(JSON.stringify(shaped));
      render(makeData(cardData));

      const groups = container.querySelectorAll('.app-card__service-ports');
      expect(groups).toHaveLength(2);
      expect(groups[0].querySelector('.app-card__service-name')?.textContent).toBe('web');
      expect(groups[0].querySelector('.app-card__port')?.textContent).toBe('80/tcp → 203.0.113.10:32000');
      expect(groups[1].querySelector('.app-card__service-name')?.textContent).toBe('db');
      expect(groups[1].querySelector('.app-card__port')?.textContent).toBe('5432/tcp → 203.0.113.10:32001');
      expect(container.querySelectorAll('.app-card__port')).toHaveLength(2);
      expect(container.querySelector('.app-card__url .app-card__link')?.textContent).toBe('https://web.example.com');

      const copyButton = container.querySelector<HTMLButtonElement>('.app-card__url button');
      flushSync(() => { copyButton!.click(); });
      expect(writeText).toHaveBeenCalledWith('https://web.example.com');
      await vi.waitFor(() => {
        expect(copyButton!.getAttribute('aria-label')).toBe('Copied');
      });
    });

    it('assigns top-level ports to the sole service when nested mappings are empty', () => {
      render(makeData({
        connection: {
          host: '203.0.113.10',
          ports: { '80/tcp': { host_ip: '203.0.113.11', host_port: 32000 } },
          services: { web: { ports: {}, instances: [{ ports: {} }] } },
        },
      }));

      expect(container.querySelectorAll('.app-card__port')).toHaveLength(1);
      expect(container.querySelector('.app-card__port')?.textContent).toBe('80/tcp → 203.0.113.11:32000');
      expect(container.querySelector('.app-card__service-ports')?.textContent).toContain('web');
    });

    it('marks wildcard port endpoints unavailable without a reported host', () => {
      render(makeData({
        url: 'https://web.example.com',
        connection: {
          host: '',
          fqdn: 'web.example.com',
          ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
        },
      }));

      expect(container.querySelector('.app-card__port')?.textContent).toBe('80/tcp → Endpoint unavailable');
    });
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
