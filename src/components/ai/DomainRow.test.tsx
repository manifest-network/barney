import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { DomainRow } from './DomainRow';

describe('DomainRow', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => { root.unmount(); });
    container.remove();
  });

  it('renders the FQDN and CNAME target', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        expectedCnameTarget: 'auto.barney0.manifest0.net',
        status: 'active',
      }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('app.example.com');
    expect(text).toContain('auto.barney0.manifest0.net');
  });

  it('renders the status label', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'pending_dns',
      }));
    });
    expect(container.textContent).toMatch(/Pending DNS/);
  });

  it('omits the arrow + target when expectedCnameTarget is missing', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'active',
      }));
    });
    expect(container.querySelector('.domain-row__target-btn')).toBeNull();
  });

  it('renders the service name badge when provided', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'active',
        serviceName: 'web',
      }));
    });
    expect(container.textContent).toMatch(/web/);
  });

  it('renders action slot children at the end', () => {
    const button = createElement('button', { 'data-testid': 'remove' }, 'Remove');
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'failed',
        actions: button,
      }));
    });
    expect(container.querySelector('[data-testid="remove"]')).not.toBeNull();
  });

  it('applies the inline modifier class when inline=true', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'active',
        inline: true,
      }));
    });
    expect(container.querySelector('.domain-row--inline')).not.toBeNull();
  });

  it('exposes status via aria-label', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'issuing_cert',
      }));
    });
    const group = container.querySelector('[role="group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toMatch(/app\.example\.com.*Issuing certificate/);
  });

  it('renders the detail line under the row when set', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'pending_dns',
        detail: 'Pointed at wrong.host — expected auto.barney0.manifest0.net',
      }));
    });
    const detail = container.querySelector('.domain-row__detail');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toMatch(/Pointed at wrong\.host/);
  });

  it('omits the detail element when detail is unset', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'pending_dns',
      }));
    });
    expect(container.querySelector('.domain-row__detail')).toBeNull();
  });

  it('includes the detail in the aria-label for screen readers', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'pending_dns',
        detail: 'Pointed at wrong.host — expected good.host',
      }));
    });
    const group = container.querySelector('[role="group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toMatch(/Pending DNS\. Pointed at wrong\.host/);
  });

  // Apex CNAMEs are RFC-forbidden; the Copy button's aria-label must flip
  // to ALIAS/ANAME for apex fqdns so a screen-reader user isn't pointed at
  // the wrong record type. See PR #93 Copilot 3236552231.
  it('uses ALIAS / ANAME in copy aria-label for apex domains', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'example.com',
        status: 'pending_dns',
        expectedCnameTarget: 'host.provider.com',
      }));
    });
    const btn = container.querySelector('button[aria-label*="Copy"]') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toMatch(/ALIAS/);
  });

  it('uses CNAME in copy aria-label for subdomains', () => {
    flushSync(() => {
      root.render(createElement(DomainRow, {
        fqdn: 'app.example.com',
        status: 'pending_dns',
        expectedCnameTarget: 'host.provider.com',
      }));
    });
    const btn = container.querySelector('button[aria-label*="Copy"]') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toMatch(/CNAME/);
    expect(btn.getAttribute('aria-label')).not.toMatch(/ALIAS/);
  });
});
