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
  getCreditAccount: vi.fn().mockResolvedValue({ balances: [] }),
  getCreditEstimate: vi.fn().mockResolvedValue(null),
  getLease: vi.fn(),
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
import { addApp, getAppByLease, updateApp, subscribeToRegistry, type AppEntry } from '../registry/appRegistry';
import { getLease } from '../api/billing';
import { logError } from '../utils/errors';
import { createAIStore } from '../stores/aiStore';
import { createWalletIdentity } from '../utils/walletIdentity';
import { AI_TOOL_API_TIMEOUT_MS } from '../config/constants';

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
  const onClose = vi.fn();

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
          <AppsSidebar onClose={onClose} />
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
    expect(streamChat).not.toHaveBeenCalled();

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

  it('shows the overview while the Morpheus relay is unavailable', async () => {
    store.setState({ isConnected: false });
    await selectApp();
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(appStatus).toHaveBeenCalledTimes(1);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it.each(['streaming', 'confirmation'])('disables sidebar selection with visible guidance during %s', async (mode) => {
    await renderApp();
    act(() => { store.setState(mode === 'streaming' ? { isStreaming: true } : { pendingConfirmation: { id: 'pending' } as any }); });
    const button = container.querySelector<HTMLButtonElement>('.apps-sidebar__app-item')!;
    expect(button.disabled).toBe(true);
    await act(async () => { button.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(appStatus).not.toHaveBeenCalled();
    expect(container.textContent).toContain(mode === 'streaming' ? 'Finish or cancel the current request' : 'Confirm or cancel the pending action');
  });

  it('keeps the sidebar open and explains a status request rejected during a wallet transition', async () => {
    await renderApp();
    act(() => { store.setState({ historyIdentity: createWalletIdentity('manifest-test', 'manifest1other') }); });
    await act(async () => { container.querySelector<HTMLButtonElement>('.apps-sidebar__app-item')!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not start the status check');
    expect(onClose).not.toHaveBeenCalled();
    expect(store.getState().messages).toEqual([]);
  });

  it('distinguishes an active lease from unavailable workload status in a chain-only read', async () => {
    store.setState({ signing: undefined });
    vi.mocked(getLease).mockResolvedValue({ ...statusResult().chainState, leaseUuid: LEASE_UUID } as any);
    await selectApp({ url: 'https://saved.example.com', connection: { host: '203.0.113.10', ports: { '80/tcp': { host_port: 32000 } } } });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(overview().textContent).toContain('Lease status: active');
    expect(overview().textContent).toContain('Workload status unavailable.');
    expect(overview().textContent).toContain('Saved endpoint');
    expect(overview().querySelector('summary')?.textContent).toBe('Saved service details');
    expect(overview().textContent).not.toContain('Last known');
    expect(overview().textContent).not.toContain('could not be confirmed');
    expect(appStatus).not.toHaveBeenCalled();
  });

  it('preserves plain Error aborts from the SDK through the executor and direct action', async () => {
    vi.mocked(appStatus).mockRejectedValue(Object.assign(new Error('SDK cancelled'), { name: 'AbortError' }));
    await selectApp();
    expect(store.getState().messages.at(-1)?.content).toBe('Status check cancelled.');
    expect(store.getState().messages.at(-1)?.error).toBeUndefined();
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.provisionState).toBe('confirmed');
    expect(logError).not.toHaveBeenCalled();
  });

  it('explains a Stop click on a deploy-success card after the lease has closed', async () => {
    await renderApp();
    act(() => {
      store.setState({ messages: [{ id: 'deploy-result', role: 'tool', toolName: 'deploy_app', timestamp: 1, content: 'Deployment complete.', card: { type: 'app', data: { name: 'my-app', status: 'running' } } }] });
      updateApp(ADDRESS, LEASE_UUID, { chainState: 'absent', provisionState: 'failed' });
    });
    const stop = Array.from(overview().querySelectorAll('button')).find((node) => node.textContent === 'Stop')!;
    await act(async () => { stop.click(); });
    expect(container.textContent).toContain('App "my-app" has no active lease to stop. No transaction is needed.');
    expect(store.getState().pendingConfirmation).toBeNull();
  });

  it.each<Record<string, { host_ip: string; host_port: number }>>([{}, { '80/tcp': { host_ip: '0.0.0.0', host_port: 0 } }])('adopts a fresh unpublished stack inventory instead of retaining old port rows (%j)', async (ports) => {
    const connection = { host: '203.0.113.10', services: { web: { ports }, db: {} } };
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection }));
    await selectApp({
      url: 'https://saved.example.com',
      connection: { host: '203.0.113.10', services: { web: { ports: { '80/tcp': { host_port: 32000 } } }, db: { ports: { '3306/tcp': { host_port: 32001 } } } } },
      manifest: JSON.stringify({ services: { web: { image: 'wordpress' }, db: { image: 'mysql' } } }),
    });
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.connection).toEqual(connection);
    expect(overview().textContent).toContain('web: No published ports.');
    expect(overview().textContent).toContain('db: No published ports.');
    expect(overview().textContent).not.toContain('Last known service details');
    expect(overview().textContent).not.toContain('Service details unavailable');
    expect(overview().querySelector('.app-card__port')).toBeNull();
  });

  it.each(['restart_app', 'update_app'])('keeps %s gated when the provider reports unknown readiness with no previous confirmation', async (toolName) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ fredStatus: { state: 2, provision_status: 'unknown' } as StatusResult['fredStatus'] }));
    await selectApp({ provisionState: undefined, manifest: JSON.stringify({ image: 'nginx' }) });
    vi.mocked(streamChat).mockReset().mockImplementation(async function* () { yield { type: 'content', content: 'Readiness is unconfirmed.' }; })
      .mockImplementationOnce(async function* () {
        yield { type: 'tool_call', toolCall: { id: 'lifecycle-call', type: 'function', function: { name: toolName, arguments: { app_name: 'my-app', ...(toolName === 'update_app' ? { image: 'nginx:alpine' } : {}) } } } };
      });
    await act(async () => { await store.getState().sendMessage(`${toolName} my-app`); });
    expect(store.getState().messages.find((message) => message.toolName === toolName)?.error).toContain('deploying');
    expect(store.getState().pendingConfirmation).toBeNull();
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
    expect(overview().querySelector('.app-card__status')?.textContent).toBe(scenario === 'query failure' ? 'Status unavailable' : 'running');
    expect(overview().textContent).toContain(scenario === 'query failure' ? 'Recorded status: running' : 'Workload status unavailable.');
    expect(overview().textContent).toContain('Last known endpoint');
    expect(overview().querySelector('.app-card__link')?.textContent).toBe(previousUrl);
  });

  it('shows the loading state while the provider read is pending', async () => {
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    await selectApp({}, false);
    expect(container.querySelector('.message-tool [role="status"]')?.textContent).toBe('Checking status of "my-app"...');
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent?.split('Checking status of "my-app"...')).toHaveLength(2);
    expect(container.querySelector('.app-card')).toBeNull();

    await act(async () => {
      resolve(statusResult());
      await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
    });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('running');
    expect(overview().textContent).toContain('Lease status: active');
    expect(overview().textContent).toContain('Workload status unavailable.');
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
    expect(overview().textContent).toContain('Service details unavailable for: web, db.');
    expect(overview().textContent).toContain('Endpoint unavailable');
  });

  it('preserves the canonical URL, stack inventory, and DNS subscriptions during a connection outage', async () => {
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
    await renderApp({ connection, url: 'https://web.provider.example', customDomains: result.chainState.items.map(({ serviceName, customDomain }) => ({ serviceName, customDomain })) });
    const onRegistryChange = vi.fn();
    const unsubscribe = subscribeToRegistry(onRegistryChange);
    try {
      await act(async () => { await store.getState().requestAppStatus('my-app'); });
      expect(onRegistryChange).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
    expect(overview().querySelector('.app-card__link')?.textContent).toBe('https://web.provider.example');
    expect(overview().textContent).toContain('Last known endpoint');
    expect(overview().textContent).toContain('Last known service details');
    expect(overview().querySelector<HTMLDetailsElement>('.app-card__saved-connections')?.open).toBe(false);
    expect(overview().textContent).toContain('Provider-reported endpoint');
    expect(overview().textContent).toContain('203.0.113.10:32002');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await act(async () => { overview().querySelector<HTMLButtonElement>('[aria-label="Copy provider-reported endpoint"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('203.0.113.10:32002');
    expect(overview().querySelector('[aria-label="Copied provider-reported endpoint"]')).not.toBeNull();
    const groups = Array.from(overview().querySelectorAll('.app-card__service-ports'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('203.0.113.10:32000');
    expect(groups[1].textContent).toContain('203.0.113.10:32001');
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.connection).toEqual(connection);
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.url).toBe('https://web.provider.example');
    expect(JSON.parse(store.getState().messages.find((message) => message.toolName === 'app_status')!.content).url).toBe('https://web.provider.example');
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
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.provisionState).toBe(provisionStatus === 'unknown' ? 'unconfirmed' : undefined);
    expect(overview().querySelector('.app-card__status')?.textContent).toBe(expected);
    expect(overview().textContent).toContain(provisionStatus === 'unknown' ? 'Provider status: unknown' : 'Workload status unavailable.');
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

  it('hides Stop when a legacy failed app has a terminal chain lease', async () => {
    const result = statusResult();
    result.chainState.state = 3;
    vi.mocked(appStatus).mockResolvedValue(result);
    await renderApp({ status: 'failed', provisionState: undefined, chainState: undefined });
    await act(async () => { await store.getState().requestAppStatus('my-app'); });
    expect(overview().querySelector('.app-card__status')?.textContent).toBe('failed');
    expect(overview().textContent).toContain('Deployment endpoint is no longer active.');
    expect(Array.from(overview().querySelectorAll('button')).find((button) => button.textContent === 'Stop')).toBeUndefined();
    await act(async () => { store.getState().requestStopApp('my-app'); });
    expect(store.getState().pendingConfirmation).toBeNull();
  });

  it.each(['restarting', 'updating', 'provisioning'])('shows provider %s without retracting confirmed readiness', async (provisionStatus) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({
      fredStatus: { state: 2, provision_status: provisionStatus } as StatusResult['fredStatus'],
    }));
    await selectApp();
    expect(overview().textContent).toContain(`Provider status: ${provisionStatus}`);
    expect(overview().textContent).not.toContain('Status unavailable');
    expect(getAppByLease(ADDRESS, LEASE_UUID)).toMatchObject({ status: 'running', provisionState: 'confirmed' });
    const data = JSON.parse(store.getState().messages.find((message) => message.toolName === 'app_status')!.content);
    expect(data).toMatchObject({ status: 'running', provision_status: provisionStatus, statusUnavailable: false });
  });

  it('keeps flat multi-service access data at deployment level without assigning endpoints to services', async () => {
    await selectApp({ manifest: JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } }) });
    expect(overview().textContent).toContain('Deployment ports');
    expect(overview().textContent).toContain('Service details unavailable for: web, db.');
    expect(overview().querySelector('.app-card__service-ports')).toBeNull();
    expect(overview().querySelectorAll('.app-card__port')).toHaveLength(1);
    expect(overview().textContent).not.toContain('Endpoint unavailable');
  });

  it.each([undefined, { host: '203.0.113.10', ports: { '80/tcp': { host_port: 32000 } } }])('labels an empty successful read accurately with previous connection %j', async (connection) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: { host: '203.0.113.10', ports: {} } }));
    await selectApp({ url: 'https://known.provider.example', connection });
    expect(overview().textContent).toContain('Last known endpoint — this read did not confirm a current endpoint.');
    expect(overview().textContent).not.toContain('could not be refreshed');
    expect(overview().textContent).not.toContain('Last known service details');
    expect(overview().textContent).not.toContain('203.0.113.10:32000');
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.connection).toEqual({ host: '203.0.113.10', ports: {} });
  });

  it('renders cached port mappings without host_ip using the reported connection host', async () => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: undefined }));
    await selectApp({
      connection: { host: '203.0.113.10', ports: { '5432/tcp': { host_port: 32001 } } },
    });
    expect(overview().querySelector('.app-card__port')?.textContent).toBe('5432/tcp → 203.0.113.10:32001');
  });

  it('refreshes directly on every sidebar selection even when a tool result is cached', async () => {
    await selectApp();
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: { host: '203.0.113.10', fqdn: 'fresh.provider.example' } }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.apps-sidebar__app-item')!.click();
      await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
    });
    expect(appStatus).toHaveBeenCalledTimes(2);
    expect(streamChat).not.toHaveBeenCalled();
    const cards = container.querySelectorAll('[aria-label="App: my-app"]');
    expect(cards).toHaveLength(2);
    expect(cards[1].textContent).toContain('https://fresh.provider.example');
    const cached = store.getState().getCachedToolResult(store.getState().getToolCacheKey('app_status', { app_name: 'my-app' }));
    expect(cached?.data).toMatchObject({ url: 'https://fresh.provider.example' });
  });

  it.each(['streaming', 'confirmation', 'wallet disconnected', 'wallet transition', 'unknown app'])('does not start a direct status request during %s', async (scenario) => {
    await renderApp();
    act(() => {
      if (scenario === 'streaming') store.setState({ isStreaming: true });
      if (scenario === 'confirmation') store.setState({ pendingConfirmation: { id: 'existing' } as any });
      if (scenario === 'wallet disconnected') store.setState({ address: undefined });
      if (scenario === 'wallet transition') store.setState({ historyIdentity: createWalletIdentity('manifest-test', 'manifest1other') });
    });
    const messages = store.getState().messages;
    await act(async () => {
      expect(await store.getState().requestAppStatus(scenario === 'unknown app' ? 'missing' : 'my-app')).toBe(false);
    });
    expect(store.getState().messages).toBe(messages);
    expect(appStatus).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it.each(['stop', 'clear history', 'wallet change'])('discards late direct status results after %s', async (scenario) => {
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    await selectApp({}, false);
    await act(async () => {
      if (scenario === 'stop') store.getState().stopStreaming();
      if (scenario === 'clear history') store.getState().clearHistory();
      if (scenario === 'wallet change') store.getState().setWalletContext({
        clientManager: store.getState().clientManager, signing: store.getState().signing,
        address: 'manifest1other', chainId: 'manifest-test',
      });
      await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
      resolve(statusResult({ fredStatus: { state: 2, provision_status: 'failed' } as StatusResult['fredStatus'] }));
    });
    expect(container.querySelector('.app-card')).toBeNull();
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.status).toBe('running');
    if (scenario === 'stop') expect(store.getState().messages.at(-1)?.content).toBe('Status check cancelled.');
    else expect(store.getState().messages).toEqual([]);
  });

  it('waits for the SDK degradation after the generic tool timeout, preserving the chain observation and attachment', async () => {
    vi.useFakeTimers();
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    try {
      await renderApp({ chainState: 'pending', provisionState: 'unconfirmed' });
      const payload = { bytes: new Uint8Array([123, 125]), filename: 'manifest.json', size: 2, hash: 'test-hash' };
      act(() => { store.setState({ pendingPayload: payload }); });
      await act(async () => {
        const request = store.getState().requestAppStatus('my-app');
        await vi.advanceTimersByTimeAsync(AI_TOOL_API_TIMEOUT_MS + 10000);
        expect(store.getState().isStreaming).toBe(true);
        resolve(statusResult({ fredStatus: undefined, connection: undefined }));
        expect(await request).toBe(true);
      });
      expect(store.getState().isStreaming).toBe(false);
      expect(store.getState().abortController).toBeNull();
      expect(store.getState().pendingPayload).toBe(payload);
      expect(store.getState().messages.at(-1)?.error).toBeUndefined();
      expect(overview().textContent).toContain('Workload status unavailable.');
      expect(getAppByLease(ADDRESS, LEASE_UUID)).toMatchObject({ chainState: 'active', provisionState: 'unconfirmed' });
    } finally { vi.useRealTimers(); }
  });

  it('reports a non-cancellation abort reason as a failure and discards the late provider result', async () => {
    let resolve!: (result: StatusResult) => void;
    vi.mocked(appStatus).mockReturnValue(new Promise((done) => { resolve = done; }));
    await selectApp({}, false);
    await act(async () => {
      store.getState().abortController!.abort(new Error('Request context failed'));
      await vi.waitFor(() => expect(store.getState().isStreaming).toBe(false));
      resolve(statusResult({ fredStatus: { state: 2, provision_status: 'failed' } as StatusResult['fredStatus'] }));
    });
    expect(store.getState().messages.at(-1)?.error).toContain('Unable to check app status');
    expect(store.getState().messages.at(-1)?.content).not.toContain('cancelled');
    expect(getAppByLease(ADDRESS, LEASE_UUID)?.status).toBe('running');
  });

  it.each([{}, { ports: {} }])('identifies an internal database service without published endpoints (%j)', async (extra) => {
    const result = statusResult({ connection: {
      host: '203.0.113.10', services: {
        web: { fqdn: 'web.provider.example', ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 32000 } } },
        db: { instances: [{ instance_index: 0, container_id: 'db-container', image: 'mysql:8', status: 'running', ...extra }] },
      },
    } as any });
    vi.mocked(appStatus).mockResolvedValue(result);
    await selectApp({ manifest: JSON.stringify({ services: { web: { image: 'wordpress' }, db: { image: 'mysql:8' } } }) });
    expect(overview().textContent).toContain('db: No published ports.');
    expect(overview().textContent).not.toContain('Service details unavailable');
    expect(overview().textContent).toContain('203.0.113.10:32000');
  });

  it.each(['web', 'app'])('uses current lease service names with a %s manifest and stale connection inventory', async (manifestName) => {
    const result = statusResult({ connection: undefined });
    result.chainState.items[0].serviceName = 'app';
    vi.mocked(appStatus).mockResolvedValue(result);
    await selectApp({
      manifest: JSON.stringify({ services: { [manifestName]: { image: 'nginx' } } }),
      url: 'https://old.provider.example',
      connection: { host: '203.0.113.10', fqdn: 'old.provider.example', ports: { '80/tcp': { host_port: 32000 } }, services: {
        web: { fqdn: 'old.provider.example', ports: { '80/tcp': { host_port: 32000 } } },
      } },
    });
    expect(overview().textContent).toContain('Service details unavailable for: app.');
    expect(overview().querySelector('.app-card__service-ports')).toBeNull();
    expect(overview().textContent).not.toContain('32000');
  });

  it.each([{ HostIp: '0.0.0.0', HostPort: '32000' }, [{ HostIp: '0.0.0.0', HostPort: '32000' }], 32000])('renders legacy saved mappings consistently with the derived URL (%j)', async (mapping) => {
    vi.mocked(appStatus).mockResolvedValue(statusResult({ connection: undefined }));
    await selectApp({
      connection: { host: '203.0.113.10', ports: { '5432/tcp': mapping } },
      manifest: JSON.stringify({ services: { db: { image: 'postgres' } } }),
    });
    expect(overview().querySelector('.app-card__link')?.textContent).toBe('203.0.113.10:32000');
    expect(overview().querySelector('.app-card__port')?.textContent).toBe('5432/tcp → 203.0.113.10:32000');
    expect(overview().textContent).not.toContain('Service details unavailable');
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
