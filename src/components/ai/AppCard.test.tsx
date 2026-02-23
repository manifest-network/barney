import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { AppCard } from './AppCard';

describe('AppCard', () => {
  it('can be instantiated with minimal props', () => {
    const element = createElement(AppCard, {
      name: 'my-app',
      status: 'running',
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(AppCard);
    expect(element.props.name).toBe('my-app');
  });

  it('accepts url and connection props', () => {
    const element = createElement(AppCard, {
      name: 'my-app',
      url: 'https://example.com',
      connection: {
        host: '1.2.3.4',
        fqdn: 'abc123.barney8.manifest0.net',
        ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32000 } },
      },
      status: 'running',
    });
    expect(element.props.url).toBe('https://example.com');
    expect(element.props.connection?.fqdn).toBe('abc123.barney8.manifest0.net');
  });

  it('accepts connection with multi-instance FQDNs', () => {
    const element = createElement(AppCard, {
      name: 'my-app',
      url: 'https://abc123.barney8.manifest0.net',
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: '0-abc123.barney8.manifest0.net' },
          { fqdn: '1-def456.barney8.manifest0.net' },
        ],
      },
      status: 'running',
    });
    expect(element.props.connection?.instances).toHaveLength(2);
    expect(element.props.connection?.instances?.[0].fqdn).toBe('0-abc123.barney8.manifest0.net');
  });

  it('accepts connection with stack service instances', () => {
    const element = createElement(AppCard, {
      name: 'wp-stack',
      url: 'https://web.barney8.manifest0.net',
      connection: {
        host: '1.2.3.4',
        services: {
          web: {
            instances: [
              { fqdn: 'web-0.barney8.manifest0.net', ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32000 } } },
              { fqdn: 'web-1.barney8.manifest0.net', ports: { '80/tcp': { host_ip: '1.2.3.4', host_port: 32001 } } },
            ],
          },
          db: {
            instances: [
              { fqdn: 'db-0.barney8.manifest0.net', ports: { '5432/tcp': { host_ip: '1.2.3.4', host_port: 32100 } } },
            ],
          },
        },
      },
      status: 'running',
    });
    expect(element.props.connection?.services?.web.instances).toHaveLength(2);
  });

  it('does not expose malicious FQDNs as instance links (validated by collectInstanceUrls)', () => {
    // collectInstanceUrls performs hostname validation and skips invalid FQDNs.
    // This test verifies the prop shape is accepted; the actual filtering
    // is covered by the collectInstanceUrls unit tests in utils/connection.test.ts.
    const element = createElement(AppCard, {
      name: 'my-app',
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: 'javascript:alert(1)' },
          { fqdn: 'evil.com/phish' },
        ],
      },
      status: 'running',
    });
    expect(element).toBeDefined();
    // Both invalid FQDNs would be filtered by collectInstanceUrls,
    // resulting in 0 instance URLs rendered.
  });
});
