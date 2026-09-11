import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => ({ address: 'manifest1tenant', wallet: { prettyName: 'Test Wallet' }, disconnect: vi.fn() }),
}));
vi.mock('../api/morpheus', () => ({ streamChat: vi.fn(), checkApiHealth: vi.fn() }));
vi.mock('../api/readClient', () => ({ getReadClient: vi.fn().mockResolvedValue({ query: {} }) }));
vi.mock('../api/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/billing')>()),
  getCreditAccount: vi.fn().mockResolvedValue(null),
  getCreditEstimate: vi.fn().mockResolvedValue(null),
}));
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/deploy')>()),
  appStatus: vi.fn(),
}));
vi.mock('../utils/errors', () => ({ logError: vi.fn() }));

import { appStatus } from '@manifest-network/manifest-sdk/deploy';
import { streamChat } from '../api/morpheus';
import { AIStoreContext, useAIStore } from '../contexts/aiStoreContext';
import { AppsSidebar } from '../components/layout/AppsSidebar';
import { MessageBubble } from '../components/ai/MessageBubble';
import { addApp, type AppEntry } from '../registry/appRegistry';
import { createAIStore } from '../stores/aiStore';
import { createWalletIdentity } from '../utils/walletIdentity';

const ADDRESS = 'manifest1tenant';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
type StatusResult = Awaited<ReturnType<typeof appStatus>>;

function statusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    lease_uuid: LEASE_UUID,
    chainState: {
      state: 2, providerUuid: 'provider-1', createdAt: '',
      items: [{ serviceName: '', customDomain: '', skuUuid: 'sku-1', quantity: 1n, lockedPrice: { amount: '1', denom: 'upwr' } }],
    },
    fredStatus: { state: 2, provision_status: 'ready' },
    connection: {
      host: '203.0.113.10', fqdn: 'deployed.provider.example',
      ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } },
    },
    ...overrides,
  } as StatusResult;
}

function Conversation() {
  const messages = useAIStore((state) => state.messages);
  return <>{messages.map((message) => <MessageBubble key={message.id} message={message} />)}</>;
}

describe('sidebar selection → app_status → rendered conversation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createAIStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    store = createAIStore();
    store.setState({
      isConnected: true,
      address: ADDRESS,
      chainId: 'manifest-test',
      historyIdentity: createWalletIdentity('manifest-test', ADDRESS),
      clientManager: {} as CosmosClientManager,
      signing: {
        providerAuth: { mint: vi.fn() },
        authTokens: { getAuthToken: vi.fn(), invalidate: vi.fn() },
        relayAuth: { signChallenge: vi.fn() },
      } as any,
      settings: { ...store.getState().settings, saveHistory: false },
    });
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield {
        type: 'tool_call',
        toolCall: { id: 'status-call', type: 'function', function: { name: 'app_status', arguments: { app_name: 'my-app' } } },
      };
    });
    vi.mocked(appStatus).mockResolvedValue(statusResult());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); store.getState().destroy(); });
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function selectApp(overrides: Partial<AppEntry> = {}, waitForResult = true) {
    addApp(ADDRESS, {
      name: 'my-app', leaseUuid: LEASE_UUID, size: 'micro',
      providerUuid: 'provider-1', providerUrl: 'https://provider.example',
      createdAt: 1, status: 'running', chainState: 'active', provisionState: 'confirmed',
      ...overrides,
    });
    await act(async () => {
      root.render(
        <AIStoreContext.Provider value={store}>
          <AppsSidebar />
          <Conversation />
        </AIStoreContext.Provider>,
      );
    });
    const selection = container.querySelector<HTMLButtonElement>('.apps-sidebar__app-item');
    expect(selection).not.toBeNull();
    await act(async () => {
      selection!.click();
      if (waitForResult) await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
    });
    expect(store.getState().messages[0].content).toBe("What's the status of my-app?");
  }

  function overview() {
    const card = container.querySelector<HTMLElement>('[aria-label="App: my-app"]');
    expect(card).not.toBeNull();
    return card!;
  }

  function domainAction() {
    const button = Array.from(overview().querySelectorAll('button')).find((node) => /custom domain/.test(node.textContent ?? ''));
    expect(button).toBeDefined();
    return button!;
  }

  it.each(['', 'custom.example.com'])('shows running status and the deployed endpoint before domain controls (%s)', async (domain) => {
    const result = statusResult();
    result.chainState.items[0].customDomain = domain;
    vi.mocked(appStatus).mockResolvedValue(result);

    await selectApp();

    const card = overview();
    expect(card.querySelector('.app-card__name')?.textContent).toBe('my-app');
    expect(card.querySelector('.app-card__status')?.textContent).toBe('running');
    expect(card.querySelector('.app-card__link')?.textContent).toBe('https://deployed.provider.example');
    expect(card.querySelector('.custom-domain-card')).toBeNull();
    expect(streamChat).toHaveBeenCalledTimes(1);

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await act(async () => { card.querySelector<HTMLButtonElement>('[aria-label="Copy endpoint"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('https://deployed.provider.example');

    const toggle = domainAction();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    if (domain) {
      expect(card.querySelector('.custom-domain-card')?.textContent).toContain(domain);
      expect(card.querySelector('.custom-domain-card')?.textContent).toContain('Remove');
    } else {
      expect(card.querySelector('input[aria-label="Custom domain"]')).not.toBeNull();
    }
    expect(card.querySelector('.app-card__status')?.textContent).toBe('running');
    expect(card.querySelector('.app-card__link')?.textContent).toBe('https://deployed.provider.example');
  });

  it.each([false, true])('keeps all stack service endpoints in the overview (existing domains: %s)', async (withDomains) => {
    const result = statusResult({
      connection: {
        host: '203.0.113.10',
        services: {
          web: { fqdn: 'web.provider.example', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
          db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } },
        },
      },
    });
    result.chainState.items = ['web', 'db'].map((serviceName) => ({
      ...result.chainState.items[0], serviceName, customDomain: withDomains ? `${serviceName}.example.com` : '',
    }));
    vi.mocked(appStatus).mockResolvedValue(result);

    await selectApp({ manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }) });

    const card = overview();
    expect(card.querySelector('.app-card__status')?.textContent).toBe('running');
    expect(card.querySelector('.app-card__link')?.textContent).toBe('https://web.provider.example');
    const groups = Array.from(card.querySelectorAll('.app-card__service-ports'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('web');
    expect(groups[0].textContent).toContain('203.0.113.10:32000');
    expect(groups[1].textContent).toContain('db');
    expect(groups[1].textContent).toContain('203.0.113.10:32001');
    expect(card.querySelector('.custom-domain-card')).toBeNull();
    await act(async () => { domainAction().click(); });
    if (withDomains) {
      expect(card.querySelector('.custom-domain-card')?.textContent).toContain('web.example.com');
      expect(card.querySelector('.custom-domain-card')?.textContent).toContain('db.example.com');
    } else {
      expect(Array.from(card.querySelectorAll('select option')).map((option) => option.getAttribute('value'))).toEqual(['', 'web', 'db']);
    }
  });

  it.each([undefined, { host: '203.0.113.10', ports: {} }])('explicitly marks missing endpoints without inventing a URL (%j)', async (connection) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection }));
    await selectApp();
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(overview().textContent).toContain('Endpoint unavailable');
    expect(overview().querySelector('.app-card__link')).toBeNull();
    expect(overview().querySelector('[aria-label="Copy endpoint"]')).toBeNull();
    expect(overview().textContent).not.toContain('https://provider.example');
  });

  it.each(['query failure', 'provider unavailable', 'missing provision status'])('labels unavailable status and cached endpoints (%s)', async (scenario) => {
    if (scenario === 'query failure') vi.mocked(appStatus).mockRejectedValue(new Error('Status request failed'));
    else vi.mocked(appStatus).mockResolvedValue(statusResult({
      fredStatus: scenario === 'provider unavailable' ? undefined : { state: 2 } as StatusResult['fredStatus'],
      connection: undefined,
    }));
    const previousUrl = 'https://previous.provider.example:8443/app?view=status#ready';
    await selectApp({ url: previousUrl });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('Status unavailable');
    expect(overview().textContent).toContain('Last known status: running');
    expect(overview().textContent).toContain('Last known endpoint');
    expect(overview().querySelector('.app-card__link')?.textContent).toBe(previousUrl);
  });

  it('shows the loading state while the provider read is pending', async () => {
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    await selectApp({}, false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading app status…');
    expect(container.querySelector('.app-card')).toBeNull();

    await act(async () => {
      resolve(statusResult());
      await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
    });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each([
    { state: 3, provisionStatus: undefined, expected: 'stopped' },
    { state: 1, provisionStatus: undefined, expected: 'deploying' },
    { state: 2, provisionStatus: 'failed', expected: 'failed' },
  ])('renders a refreshed $expected state instead of the cached running state', async ({ state, provisionStatus, expected }) => {
    const result = statusResult();
    result.chainState.state = state;
    result.fredStatus = provisionStatus ? { state: 2, provision_status: provisionStatus } as StatusResult['fredStatus'] : undefined;
    vi.mocked(appStatus).mockResolvedValue(result);
    await selectApp();
    expect(overview().querySelector('.app-card__status')?.textContent).toBe(expected);
    expect(overview().getAttribute('data-status')).toBe(expected);
    expect(domainActionIfPresent()).toBeUndefined();
  });

  function domainActionIfPresent() {
    return Array.from(overview().querySelectorAll('button')).find((node) => /custom domain/.test(node.textContent ?? ''));
  }

  it('shows reported connection data even when the provider status read is unavailable', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ fredStatus: undefined }));
    await selectApp();
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('Status unavailable');
    expect(overview().querySelector('.app-card__link')?.textContent).toBe('https://deployed.provider.example');
    expect(overview().textContent).not.toContain('Last known endpoint');
  });

  it('uses the provider status endpoint when connection data is unavailable', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({
      connection: undefined,
      fredStatus: { state: 2, provision_status: 'ready', endpoints: { '80/tcp': 'http://status.provider.example:32000' } } as StatusResult['fredStatus'],
    }));
    await selectApp();
    expect(overview().querySelector('.app-card__link')?.textContent).toBe('https://status.provider.example');
    expect(overview().textContent).not.toContain('Last known endpoint');
  });

  it('shows unavailable endpoints for stack services with no access data', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: undefined }));
    await selectApp({ manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }) });
    const groups = Array.from(overview().querySelectorAll('.app-card__service-ports'));
    expect(groups.map((group) => group.textContent)).toEqual(['webEndpoint unavailable', 'dbEndpoint unavailable']);
  });

  it('keeps the overview readable when cached port and service shapes are invalid', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: undefined }));
    await selectApp({
      connection: {
        host: '203.0.113.10',
        ports: { '80/tcp': null },
        services: {
          web: null,
          db: { ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 }, '5433/tcp': null }, instances: [null] },
        },
      },
      manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }),
    });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(overview().textContent).toContain('Endpoint unavailable');
    expect(overview().textContent).toContain('203.0.113.10:32001');
  });
});
