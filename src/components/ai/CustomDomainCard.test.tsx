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

      // Type a valid FQDN
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
