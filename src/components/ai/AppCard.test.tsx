import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AppCard } from './AppCard';

let container: HTMLDivElement;
let root: Root;

function render(props: Parameters<typeof AppCard>[0]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => { root.render(createElement(AppCard, props)); });
}

afterEach(() => {
  flushSync(() => { root?.unmount(); });
  container?.remove();
});

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

  it('renders instance links with valid https hrefs for multi-instance FQDNs', () => {
    render({
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

    const links = container.querySelectorAll<HTMLAnchorElement>('.app-card__instance-link');
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('https://0-abc123.barney8.manifest0.net/');
    expect(links[1].href).toBe('https://1-def456.barney8.manifest0.net/');
    // Verify security attributes
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
  });

  it('renders no instance links for a single-instance deployment', () => {
    render({
      name: 'my-app',
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: '0-abc123.barney8.manifest0.net' },
        ],
      },
      status: 'running',
    });

    const links = container.querySelectorAll('.app-card__instance-link');
    expect(links).toHaveLength(0);
  });

  it('renders no instance links when FQDNs are malicious', () => {
    render({
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

    const links = container.querySelectorAll('.app-card__instance-link');
    expect(links).toHaveLength(0);
    // No instances section should be rendered at all
    expect(container.querySelector('.app-card__instances')).toBeNull();
  });

  it('renders only valid instance links when mixed with invalid FQDNs', () => {
    render({
      name: 'my-app',
      connection: {
        host: '1.2.3.4',
        instances: [
          { fqdn: '0-abc123.barney8.manifest0.net' },
          { fqdn: 'javascript:alert(1)' },
          { fqdn: '1-def456.barney8.manifest0.net' },
        ],
      },
      status: 'running',
    });

    const links = container.querySelectorAll<HTMLAnchorElement>('.app-card__instance-link');
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('https://0-abc123.barney8.manifest0.net/');
    expect(links[1].href).toBe('https://1-def456.barney8.manifest0.net/');
  });

  it('renders stack service instance links from services map', () => {
    render({
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
      status: 'running',
    });

    const links = container.querySelectorAll<HTMLAnchorElement>('.app-card__instance-link');
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('https://web-0.barney8.manifest0.net/');
    expect(links[1].href).toBe('https://web-1.barney8.manifest0.net/');
  });
});
