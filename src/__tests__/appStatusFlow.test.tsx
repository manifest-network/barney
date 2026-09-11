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
import { addApp, getAppByLease, type AppEntry } from '../registry/appRegistry';
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
    vi.mocked(streamChat).mockReset().mockImplementation(async function* () {
      yield { type: 'content', content: 'The app overview is ready.' };
    }).mockImplementationOnce(async function* () {
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

  async function renderApp(overrides: Partial<AppEntry> = {}) {
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
  }

  async function selectApp(overrides: Partial<AppEntry> = {}, waitForResult = true) {
    await renderApp(overrides);
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
    expect(streamChat).toHaveBeenCalledTimes(2);

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
    expect(overview().textContent).toContain('Recorded status: running');
    expect(overview().textContent).toContain('Last known endpoint');
    expect(overview().querySelector('.app-card__link')?.textContent).toBe(previousUrl);
  });

  it('shows the loading state while the provider read is pending', async () => {
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    await selectApp({}, false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Checking status of "my-app"...');
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

  it('preserves stack endpoints and DNS targets when only the primary URL refreshes', async () => {
    const result = statusResult({
      connection: undefined,
      fredStatus: { state: 2, provision_status: 'ready', endpoints: { '80/tcp': 'http://203.0.113.10:32002' } } as StatusResult['fredStatus'],
    });
    result.chainState.items = ['web', 'db'].map((serviceName) => ({
      ...result.chainState.items[0], serviceName, customDomain: `${serviceName}.example.com`,
    }));
    vi.mocked(appStatus).mockResolvedValue(result);
    const connection = {
      host: '203.0.113.10',
      services: {
        web: { fqdn: 'web.provider.example', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
        db: { fqdn: 'db.provider.example', ports: { '5432/tcp': { host_ip: '0.0.0.0', host_port: 32001 } } },
      },
    };
    await selectApp({ connection, url: 'https://web.provider.example' });
    expect(overview().querySelector('.app-card__link')?.textContent).toBe('203.0.113.10:32002');
    expect(overview().textContent).not.toContain('Last known endpoint');
    expect(overview().textContent).toContain('Last known service details');
    const groups = Array.from(overview().querySelectorAll('.app-card__service-ports'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('203.0.113.10:32000');
    expect(groups[1].textContent).toContain('203.0.113.10:32001');
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.connection).toEqual(connection);
    await act(async () => { domainAction().click(); });
    expect(overview().querySelector('.custom-domain-card')?.textContent).toContain('web.provider.example');
    expect(overview().querySelector('.custom-domain-card')?.textContent).toContain('db.provider.example');
  });

  it.each([
    { provisionStatus: 'unknown', status: 'running', chainState: 'active', expected: 'deploying' },
    { provisionStatus: undefined, status: 'deploying', chainState: 'pending', expected: 'running' },
  ] as const)('keeps the recorded card, model data, and registry consistent ($provisionStatus)', async ({ provisionStatus, status, chainState, expected }) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({
      fredStatus: provisionStatus ? { state: 2, provision_status: provisionStatus } as StatusResult['fredStatus'] : undefined,
    }));
    await selectApp({ status, chainState, provisionState: undefined });
    const toolMessage = store.getState().messages.find((message) => message.toolName === 'app_status')!;
    expect(JSON.parse(toolMessage.content).status).toBe(expected);
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.status).toBe(expected);
    expect(overview().textContent).toContain(`Recorded status: ${expected}`);
  });

  it.each(['closed', 'rejected', 'expired', 'provider terminal'] as const)('marks %s endpoints inactive and hides stale access controls', async (scenario) => {
    const result = statusResult();
    result.chainState.state = scenario === 'provider terminal' ? 2 : { closed: 3, rejected: 4, expired: 5 }[scenario];
    result.chainState.items[0].customDomain = 'custom.example.com';
    if (scenario === 'provider terminal') result.fredStatus = { state: 3 } as StatusResult['fredStatus'];
    vi.mocked(appStatus).mockResolvedValue(result);
    await selectApp({
      url: 'https://old.provider.example', connection: { host: '203.0.113.10', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
      manifest: JSON.stringify({ services: { web: { image: 'nginx' } } }),
    });
    expect(overview().textContent).toContain('Deployment endpoint is no longer active.');
    expect(overview().textContent).not.toContain('could not be refreshed');
    expect(overview().querySelector('[aria-label="Copy endpoint"]')).toBeNull();
    expect(overview().querySelector('.app-card__link, .app-card__service-ports, .app-card__port')).toBeNull();
    expect(domainActionIfPresent()).toBeUndefined();
    expect(JSON.parse(store.getState().messages.find((message) => message.toolName === 'app_status')!.content).url).toBeUndefined();
  });

  it('offers Stop for a failed workload whose lease is still active', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ fredStatus: { state: 2, provision_status: 'failed' } as StatusResult['fredStatus'] }));
    await selectApp();
    const stop = Array.from(overview().querySelectorAll('button')).find((button) => button.textContent === 'Stop');
    expect(stop).toBeDefined();
    await act(async () => { stop!.click(); });
    expect(store.getState().pendingConfirmation?.action.toolName).toBe('stop_app');
    expect(store.getState().pendingConfirmation?.action.args.app_name).toBe('my-app');
  });

  it('shows flat endpoint metadata once under a single named service', async () => {
    await selectApp({ manifest: JSON.stringify({ services: { web: { image: 'nginx' } } }) });
    const groups = overview().querySelectorAll('.app-card__service-ports');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('web');
    expect(groups[0].textContent).toContain('deployed.provider.example');
    expect(groups[0].textContent).toContain('203.0.113.10:32000');
    expect(overview().querySelectorAll('.app-card__port')).toHaveLength(1);
    expect(overview().textContent).not.toContain('Endpoint unavailable');
  });

  it('keeps size, image, and creation time available in expandable details', async () => {
    await selectApp({ manifest: JSON.stringify({ image: 'nginx:alpine' }) });
    const details = container.querySelector<HTMLButtonElement>('[aria-label="Expand tool result for app_status"]');
    expect(details).not.toBeNull();
    expect(container.querySelector('.message-tool-content')).toBeNull();
    await act(async () => { details!.click(); });
    const content = container.querySelector('.message-tool-content')?.textContent;
    expect(content).toContain('micro');
    expect(content).toContain('nginx:alpine');
    expect(content).toContain('1970-01-01T00:00:00.001Z');
  });

  it.each(['restart_app', 'update_app'])('continues a refused %s through status refresh to a new confirmation', async (toolName) => {
    const args = { app_name: 'my-app', ...(toolName === 'update_app' ? { image: 'nginx:alpine' } : {}) };
    let iteration = 0;
    vi.mocked(streamChat).mockReset().mockImplementation(async function* () {
      const name = iteration++ === 1 ? 'app_status' : toolName;
      yield { type: 'tool_call', toolCall: { id: `call-${iteration}`, type: 'function', function: { name, arguments: name === 'app_status' ? { app_name: 'my-app' } : args } } };
    });
    await renderApp({ status: 'deploying', provisionState: 'unconfirmed', manifest: JSON.stringify({ image: 'nginx', ports: { '80/tcp': {} } }) });
    await act(async () => { await store.getState().sendMessage(`${toolName === 'restart_app' ? 'Restart' : 'Update'} my-app`); });
    const messages = store.getState().messages;
    expect(messages.find((message) => message.toolName === toolName)?.error).toContain('deploying');
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(streamChat).toHaveBeenCalledTimes(3);
    expect(store.getState().pendingConfirmation?.action.toolName).toBe(toolName);
    expect(store.getState().pendingConfirmation?.action.args.app_name).toBe('my-app');
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
