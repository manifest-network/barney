import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { useManifestMCP, type UseManifestMCPResult } from './useManifestMCP';

// --- Mocks ---
//
// useChain is the only source of wallet identity/capability. We drive it per
// test via `mockChain` and assert what the hook derives — specifically that a
// connected wallet WITHOUT signArbitrary yields `signing === undefined` (the
// ENG-466 / Copilot PR #104 fast-fail gate) while still exposing a
// clientManager, and a wallet WITH signArbitrary yields a SigningContext.

let mockChain: {
  address: string | undefined;
  isWalletConnected: boolean;
  getOfflineSigner: () => unknown;
  signArbitrary?: (address: string, data: string) => Promise<unknown>;
};

vi.mock('@cosmos-kit/react', () => ({
  useChain: () => mockChain,
}));

// The factory arrows defer reading these consts until the mocked module is
// actually called (past the hoist-time TDZ); the `...args` rest signatures let
// the hook's real call arity flow through to the vi.fn spies.
const mockManager = { disconnect: vi.fn() };
const mockGetInstance = vi.fn<(...args: unknown[]) => typeof mockManager>(() => mockManager);
const mockCreateSignerAdapter = vi.fn<(...args: unknown[]) => { type: string }>(() => ({
  type: 'signer-adapter',
}));

vi.mock('@manifest-network/manifest-sdk', () => ({
  CosmosClientManager: {
    getInstance: (...args: unknown[]) => mockGetInstance(...args),
  },
  createSignerAdapter: (...args: unknown[]) => mockCreateSignerAdapter(...args),
}));

const mockProviderAuth = {
  providerToken: vi.fn().mockResolvedValue('provider-token'),
  leaseDataToken: vi.fn().mockResolvedValue('lease-data-token'),
};
const mockCreateProviderAuth = vi.fn<(...args: unknown[]) => typeof mockProviderAuth>(
  () => mockProviderAuth,
);

vi.mock('@manifest-network/manifest-sdk/deploy', () => ({
  createProviderAuth: (...args: unknown[]) => mockCreateProviderAuth(...args),
}));

// Keep the mutex trivial: signArbitraryWithMutex forwards to the wrapped fn.
// ENG-312 Phase 8: the mutex no longer exposes a public withSign.
vi.mock('../ai/toolExecutor/batchRunner', () => ({
  createSigningMutex: (signArbitrary: unknown) => ({
    signArbitraryWithMutex: signArbitrary,
  }),
}));

vi.mock('../config/chain', () => ({
  CHAIN_NAME: 'manifestlocal',
  CHAIN_ID: 'manifest-test',
  GAS_PRICE: '0.025factory/test/upwr',
}));

vi.mock('../api/config', () => ({
  RPC_ENDPOINT: 'http://localhost:26657',
}));

// --- Harness ---

let captured: UseManifestMCPResult | undefined;

function Harness() {
  // Test harness: capture the hook's return for assertion (renderHook-style).
  // eslint-disable-next-line react-hooks/globals
  captured = useManifestMCP();
  return null;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  captured = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The init effect has no `await` before its setState calls, so flushSync
  // runs the effect and re-renders synchronously; a second flush guarantees the
  // Harness reads the post-effect state.
  flushSync(() => root.render(createElement(Harness)));
  flushSync(() => root.render(createElement(Harness)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChain = {
    address: 'manifest1test',
    isWalletConnected: true,
    getOfflineSigner: () => ({ getAccounts: vi.fn() }),
    signArbitrary: vi.fn().mockResolvedValue({ pub_key: { type: 't', value: 'v' }, signature: 's' }),
  };
});

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
});

describe('useManifestMCP signing capability gate', () => {
  it('exposes a SigningContext whose authTokens delegate to a single createProviderAuth', async () => {
    render();
    expect(captured?.signing).toBeDefined();

    // ONE minter, built from the signer adapter + chain id.
    expect(mockCreateProviderAuth).toHaveBeenCalledTimes(1);
    expect(mockCreateProviderAuth).toHaveBeenCalledWith(
      { type: 'signer-adapter' },
      { chainId: 'manifest-test' },
    );

    // authTokens is a thin address-binding adapter over THAT instance.
    await captured?.signing?.authTokens.getAuthToken('lease-1' as never);
    expect(mockProviderAuth.providerToken).toHaveBeenCalledWith({
      address: 'manifest1test',
      leaseUuid: 'lease-1',
    });

    // Connected: clientManager present.
    expect(captured?.clientManager).toBe(mockManager);
    expect(captured?.clientAddress).toBe('manifest1test');
    expect(captured?.isConnected).toBe(true);
  });

  it('leaves signing undefined (but keeps clientManager) when signArbitrary is unsupported', () => {
    mockChain.signArbitrary = undefined;
    render();
    // The regression guard: no SigningContext for a signArbitrary-less wallet,
    // so the tool executor fast-fails before any billed action.
    expect(captured?.signing).toBeUndefined();
    // The minter must NOT be built when the wallet cannot sign.
    expect(mockCreateProviderAuth).not.toHaveBeenCalled();
    expect(mockCreateSignerAdapter).not.toHaveBeenCalled();
    // Chain TXs/queries still work: clientManager is present and connected.
    expect(captured?.clientManager).toBe(mockManager);
    expect(captured?.clientAddress).toBe('manifest1test');
    expect(captured?.isConnected).toBe(true);
  });

  it('clears signing and clientManager when the wallet disconnects', () => {
    mockChain = {
      address: undefined,
      isWalletConnected: false,
      getOfflineSigner: () => ({ getAccounts: vi.fn() }),
      signArbitrary: undefined,
    };
    render();
    expect(captured?.signing).toBeUndefined();
    expect(captured?.clientManager).toBeNull();
    expect(captured?.clientAddress).toBeUndefined();
    expect(captured?.isConnected).toBe(false);
  });
});
