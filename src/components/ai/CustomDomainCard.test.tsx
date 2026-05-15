import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const sendMessage = vi.fn();
let dnsStatuses: Map<string, { kind: string; expectedCnameTarget?: string; detail?: string }> = new Map();

vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({ sendMessage, dnsStatuses }),
}));

import { CustomDomainCard } from './CustomDomainCard';
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

/** React tracks its own input value separately, so direct .value assignment is ignored.
 *  Use the prototype setter to trigger React's onChange handler. */
function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CustomDomainCard', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    dnsStatuses = new Map();
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

  // Apex CNAMEs are RFC-forbidden; the apex warning flow lets the user
  // proceed anyway, but the status view here must surface the right
  // record type so the user doesn't paste a CNAME at the apex into their
  // registrar and get rejected. See PR #93 Copilot 3236552231.
  it('renders ALIAS / ANAME label for apex domains in single-domain view', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: 'example.com' }) }));
    });
    const text = container.textContent ?? '';
    expect(text).toMatch(/ALIAS/);
    expect(text).not.toMatch(/^CNAME/m); // visible label line shouldn't start with CNAME
    const copyBtn = container.querySelector('button[aria-label*="Copy ALIAS"]');
    expect(copyBtn).not.toBeNull();
  });

  it('renders CNAME label for subdomains in single-domain view', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: 'app.example.com' }) }));
    });
    const text = container.textContent ?? '';
    expect(text).toMatch(/CNAME/);
    expect(text).not.toMatch(/ALIAS/);
    const copyBtn = container.querySelector('button[aria-label*="Copy CNAME"]');
    expect(copyBtn).not.toBeNull();
  });

  it('defaults to pending_dns when no slice entry exists', () => {
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Pending DNS/i);
  });

  it('reflects active status from the shared slice', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'active', expectedCnameTarget: 'auto.barney0.manifest0.net' }],
    ]);
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Active/);
  });

  it('reflects issuing_cert status from the shared slice', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'issuing_cert', expectedCnameTarget: 'auto.barney0.manifest0.net' }],
    ]);
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Issuing certificate/);
  });

  it('uses the slice expectedCnameTarget when present (preferred over data fallback)', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', { kind: 'active', expectedCnameTarget: 'live.target.host' }],
    ]);
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData({ expectedCnameTarget: 'stale.target.host' }) }));
    });
    expect(container.textContent).toContain('live.target.host');
    expect(container.textContent).not.toContain('stale.target.host');
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

  describe('no-domain form (fqdn === "")', () => {
    it('renders an input + Set + Ask Barney button', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '' }) }));
      });
      const text = container.textContent ?? '';
      expect(text).toContain('Custom domain');
      expect(text).toContain('Ask Barney');
      expect(container.querySelector('input')).not.toBeNull();
    });

    it('disables Set when input is empty or invalid', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '' }) }));
      });
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
      expect(setBtn.disabled).toBe(true);
    });

    it('enables Set after a valid fqdn is entered, then sends "Point ... at ..." on click', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '', appName: 'my-api' }) }));
      });
      const input = container.querySelector('input') as HTMLInputElement;
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;

      flushSync(() => { setReactInputValue(input, 'app.example.com'); });
      expect(setBtn.disabled).toBe(false);

      flushSync(() => { setBtn.click(); });
      expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/Point app\.example\.com at my-api/i));
    });

    it('passes service_name suffix when set', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '', appName: 'wp', serviceName: 'web' }) }));
      });
      const input = container.querySelector('input') as HTMLInputElement;
      flushSync(() => { setReactInputValue(input, 'app.example.com'); });
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
      flushSync(() => { setBtn.click(); });
      expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/Point app\.example\.com at wp.*service: web/i));
    });

    it('Ask Barney sends a guided prompt regardless of input', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '', appName: 'my-api' }) }));
      });
      const askBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Ask Barney') as HTMLButtonElement;
      flushSync(() => { askBtn.click(); });
      expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/help me set a custom domain for my-api/i));
    });

    it('rejects invalid input (no dot)', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '' }) }));
      });
      const input = container.querySelector('input') as HTMLInputElement;
      flushSync(() => { setReactInputValue(input, 'localhost'); });
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
      expect(setBtn.disabled).toBe(true);
    });

    it('keeps Set disabled for IPv4 literals (matches validator)', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '' }) }));
      });
      const input = container.querySelector('input') as HTMLInputElement;
      flushSync(() => { setReactInputValue(input, '192.168.1.1'); });
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
      expect(setBtn.disabled).toBe(true);
    });

    it('keeps Set disabled for IPv6 literals', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData({ fqdn: '' }) }));
      });
      const input = container.querySelector('input') as HTMLInputElement;
      flushSync(() => { setReactInputValue(input, '2606:4700::1111'); });
      const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
      expect(setBtn.disabled).toBe(true);
    });

    describe('stack service picker', () => {
      it('renders a service picker when serviceNames has multiple entries', () => {
        flushSync(() => {
          root.render(createElement(CustomDomainCard, {
            data: makeData({ fqdn: '', serviceNames: ['web', 'api'] }),
          }));
        });
        const select = container.querySelector('select');
        expect(select).not.toBeNull();
        const options = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
        expect(options).toContain('web');
        expect(options).toContain('api');
      });

      it('does not render a picker when only one service exists', () => {
        flushSync(() => {
          root.render(createElement(CustomDomainCard, {
            data: makeData({ fqdn: '', serviceNames: ['web'] }),
          }));
        });
        expect(container.querySelector('select')).toBeNull();
      });

      it('blocks Set until a service is picked on a stack', () => {
        flushSync(() => {
          root.render(createElement(CustomDomainCard, {
            data: makeData({ fqdn: '', appName: 'stack', serviceNames: ['web', 'api'] }),
          }));
        });
        const input = container.querySelector('input') as HTMLInputElement;
        flushSync(() => { setReactInputValue(input, 'app.example.com'); });
        const setBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Set') as HTMLButtonElement;
        expect(setBtn.disabled).toBe(true);

        const select = container.querySelector('select') as HTMLSelectElement;
        flushSync(() => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
          setter.call(select, 'web');
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(setBtn.disabled).toBe(false);

        flushSync(() => { setBtn.click(); });
        expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/Point app\.example\.com at stack.*service: web/i));
      });
    });
  });

  it('renders detail from the slice as a sub-line under the pill', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', {
        kind: 'pending_dns',
        expectedCnameTarget: 'auto.barney0.manifest0.net',
        detail: 'Pointed at wrong.host — expected auto.barney0.manifest0.net',
      }],
    ]);
    flushSync(() => {
      root.render(createElement(CustomDomainCard, { data: makeData() }));
    });
    expect(container.textContent).toMatch(/Pointed at wrong\.host/);
  });

  it('suppresses the stuck-hint when the slice entry has a detail (mismatch)', () => {
    dnsStatuses = new Map([
      ['lease-1::app.example.com', {
        kind: 'pending_dns',
        expectedCnameTarget: 'auto.barney0.manifest0.net',
        detail: 'Pointed at wrong.host — expected auto.barney0.manifest0.net',
      }],
    ]);
    // Far in the future so the threshold has long elapsed.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, { data: makeData() }));
      });
      expect(container.textContent).not.toMatch(/verify with/i);
    } finally {
      Date.now = realNow;
    }
  });

  describe('multi-domain consolidated view', () => {
    // Symmetry regression: PR #93 Copilot 3248436527. The multi-domain view
    // previously inverted the single-view precedence on line 302, displaying
    // a stale snapshot when the live `dnsStatuses` entry carried a refreshed
    // target. Both views must prefer the LIVE target. The single-view side
    // of this contract is locked by the existing "uses the slice
    // expectedCnameTarget when present (preferred over data fallback)" test.
    it('multi-domain view prefers the live dnsStatuses target over the snapshot when both are present', () => {
      dnsStatuses = new Map([
        ['lease-1::web.example.com', {
          kind: 'pending_dns',
          expectedCnameTarget: 'web.refreshed.barney0.manifest0.net',  // live
        }],
      ]);
      flushSync(() => {
        root.render(createElement(CustomDomainCard, {
          data: makeData({
            fqdn: '',
            domains: [
              {
                serviceName: 'web',
                customDomain: 'web.example.com',
                expectedCnameTarget: 'web.stale.barney0.manifest0.net',  // snapshot
              },
            ],
          }),
        }));
      });
      expect(container.textContent).toContain('web.refreshed.barney0.manifest0.net');
      expect(container.textContent).not.toContain('web.stale');
    });

    it('renders one DomainRow per domain with their status from dnsStatuses', () => {
      dnsStatuses = new Map([
        ['lease-1::web.example.com', { kind: 'active', expectedCnameTarget: 'web.auto.barney0.manifest0.net' }],
        ['lease-1::api.example.com', { kind: 'pending_dns', expectedCnameTarget: 'api.auto.barney0.manifest0.net' }],
      ]);
      flushSync(() => {
        root.render(createElement(CustomDomainCard, {
          data: makeData({
            fqdn: '',
            domains: [
              { serviceName: 'web', customDomain: 'web.example.com', expectedCnameTarget: 'web.auto.barney0.manifest0.net' },
              { serviceName: 'api', customDomain: 'api.example.com', expectedCnameTarget: 'api.auto.barney0.manifest0.net' },
            ],
          }),
        }));
      });
      const text = container.textContent ?? '';
      expect(text).toContain('web.example.com');
      expect(text).toContain('api.example.com');
      expect(text).toMatch(/Active/);
      expect(text).toMatch(/Pending DNS/);
    });

    it('falls back to pending_dns when no status entry exists', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, {
          data: makeData({
            fqdn: '',
            domains: [
              { serviceName: 'web', customDomain: 'web.example.com', expectedCnameTarget: 'web.auto.barney0.manifest0.net' },
            ],
          }),
        }));
      });
      expect(container.textContent).toMatch(/Pending DNS/);
    });

    it('Change/Remove dispatch with the correct service name', () => {
      flushSync(() => {
        root.render(createElement(CustomDomainCard, {
          data: makeData({
            appName: 'stack',
            fqdn: '',
            domains: [
              { serviceName: 'web', customDomain: 'web.example.com' },
              { serviceName: 'api', customDomain: 'api.example.com' },
            ],
          }),
        }));
      });
      const allButtons = Array.from(container.querySelectorAll('button'));
      const changeButtons = allButtons.filter((b) => b.textContent === 'Change');
      const removeButtons = allButtons.filter((b) => b.textContent === 'Remove');
      expect(changeButtons.length).toBe(2);
      expect(removeButtons.length).toBe(2);

      flushSync(() => { changeButtons[0].click(); });
      expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/change.*stack.*service: web/i));

      flushSync(() => { removeButtons[1].click(); });
      expect(sendMessage).toHaveBeenCalledWith(expect.stringMatching(/remove.*stack.*service: api/i));
    });

    it('surfaces the wrong-target detail per row from dnsStatuses', () => {
      dnsStatuses = new Map([
        ['lease-1::web.example.com', {
          kind: 'active',
          expectedCnameTarget: 'web.auto.barney0.manifest0.net',
        }],
        ['lease-1::api.example.com', {
          kind: 'pending_dns',
          expectedCnameTarget: 'api.auto.barney0.manifest0.net',
          detail: 'Pointed at wrong.host — expected api.auto.barney0.manifest0.net',
        }],
      ]);
      flushSync(() => {
        root.render(createElement(CustomDomainCard, {
          data: makeData({
            fqdn: '',
            domains: [
              { serviceName: 'web', customDomain: 'web.example.com' },
              { serviceName: 'api', customDomain: 'api.example.com' },
            ],
          }),
        }));
      });
      expect(container.textContent).toMatch(/Pointed at wrong\.host/);
    });
  });
});
