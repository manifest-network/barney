import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createAIStore } from '../stores/aiStore';
import { processToolCallsFn } from '../stores/aiActions/toolExecution';
import { AIStoreContext } from '../contexts/aiStoreContext';
import { useAI } from '../hooks/useAI';
import { ConfirmationCard } from '../components/ai/ConfirmationCard';
import { executeTool, executeConfirmedTool } from '../ai/toolExecutor';
import { executeConfirmedFundCredits } from '../ai/toolExecutor/compositeTransactions';
import { AI_TOOLS, isValidToolName, requiresConfirmation } from '../ai/tools';
import { transactionConfirmation, type TransactionPlan, type TransactionToolName } from '../ai/toolExecutor/transactionPlans';
import { DENOMS } from '../api/config';
import type { CosmosClientManager } from '@manifest-network/manifest-sdk';

vi.mock('../api/morpheus', () => ({
  checkApiHealth: vi.fn().mockResolvedValue(false),
  streamChat: vi.fn(),
}));
vi.mock('../ai/streamUtils', () => ({
  processStreamWithTimeout: vi.fn().mockResolvedValue({ content: 'Done.', thinking: '', toolCalls: [] }),
}));
vi.mock('@manifest-network/manifest-sdk/deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@manifest-network/manifest-sdk/deploy')>()),
  deployManifest: vi.fn(),
  stopApp: vi.fn(),
  fundCredits: vi.fn(),
  restartApp: vi.fn(),
  updateApp: vi.fn(),
  setItemCustomDomain: vi.fn(),
}));

import { deployManifest, stopApp, fundCredits, restartApp, updateApp, setItemCustomDomain } from '@manifest-network/manifest-sdk/deploy';

const ADDRESS = 'manifest1test';
const CLIENT = {} as CosmosClientManager;
const mutations = [deployManifest, stopApp, fundCredits, restartApp, updateApp, setItemCustomDomain];
const unsupported = ['cosmos_tx', 'cosmosTx', 'executeTx', 'signAndBroadcast', 'bank_send', 'withdraw_credit', 'batch_deploy', 'unregistered_tool'];

function RenderConfirmation() {
  const { pendingConfirmation, confirmAction, cancelAction, isStreaming } = useAI();
  return pendingConfirmation && createElement(ConfirmationCard, {
    action: pendingConfirmation.action,
    onConfirm: (overrides) => { void confirmAction(overrides); },
    onCancel: cancelAction,
    isExecuting: isStreaming,
  });
}

describe('SDK transaction consent boundary', () => {
  let store: ReturnType<typeof createAIStore>;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store = createAIStore();
    store.getState().setWalletContext({
      address: ADDRESS, clientManager: CLIENT, chainId: 'manifest-test', signing: undefined,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.getState().destroy();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function modelCalls(names: string[]) {
    store.getState().addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: 1 });
    const toolCalls = names.map((name, index) => ({
      id: `call-${index}`, type: 'function' as const,
      function: { name, arguments: { amount: 1.000001, module: 'bank', subcommand: 'send', args: '["other","999999upwr"]' } },
    }));
    await processToolCallsFn(store.getState, store.setState, toolCalls, 'assistant', {
      content: '', thinking: '', toolCalls,
    });
  }

  function options() {
    const state = store.getState();
    return {
      address: ADDRESS, clientManager: CLIENT, tiers: [],
      authorization: {
        originAddress: ADDRESS, chainId: state.chainId,
        clientGeneration: state.clientGeneration, signerGeneration: state.signerGeneration,
      },
      assertAuthorization: vi.fn(),
    };
  }

  it('rejects invented and removed transaction names from a model response without creating consent or signing', async () => {
    await modelCalls(unsupported);
    expect(store.getState().pendingConfirmation).toBeNull();
    for (const name of unsupported) {
      expect(isValidToolName(name)).toBe(false);
      expect(AI_TOOLS.some((tool) => tool.function.name === name)).toBe(false);
      expect(requiresConfirmation(name)).toBe(false);
      expect(store.getState().messages.some((message) => message.error === `Unknown tool: ${name}`)).toBe(true);
      expect((await executeTool(name, {}, options())).success).toBe(false);
      // The UI-only batch name has its own validated plan; the model cannot
      // dispatch it or forge one by passing arbitrary transaction arguments.
      expect((await executeConfirmedTool(name, { module: 'bank', subcommand: 'send' }, options())).success).toBe(false);
    }
    for (const mutate of mutations) expect(mutate).not.toHaveBeenCalled();
  });

  it('cannot use the registered read-only query tool to send a transaction', async () => {
    await modelCalls(['cosmos_query']);
    expect(store.getState().pendingConfirmation).toBeNull();
    expect(store.getState().messages.some((message) => message.error?.includes('"bank send" is not allowed'))).toBe(true);
    for (const mutate of mutations) expect(mutate).not.toHaveBeenCalled();
  });

  it('requires a rendered Confirm click even when the wallet automatically approves signatures', async () => {
    // Mirrors main.tsx's Web3Auth promptSign behavior at the SDK boundary.
    const promptSign = vi.fn(async () => true);
    vi.mocked(fundCredits).mockImplementation(async () => {
      await promptSign();
      return { code: 0, transactionHash: 'funded' } as never;
    });
    await modelCalls(['fund_credits']);
    expect(store.getState().pendingConfirmation?.action.args).toEqual({ amount: 1.000001, address: ADDRESS });
    expect(fundCredits).not.toHaveBeenCalled();
    expect(promptSign).not.toHaveBeenCalled();

    await act(async () => {
      root.render(createElement(AIStoreContext.Provider, { value: store }, createElement(RenderConfirmation)));
    });
    expect(container.textContent).toContain('Move 1.000001 PWR from your wallet into deployment credits');
    expect(container.querySelector('[data-testid="transaction-fee-limit"]')?.textContent).toContain('Maximum network fee');
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Confirm');
    expect(confirm).toBeDefined();
    await act(async () => { confirm!.click(); });
    expect(fundCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ chain: CLIENT }),
      { amount: `1000001${DENOMS.PWR}` },
      { waitForConfirmation: true, signal: expect.any(AbortSignal) },
    );
    expect(promptSign).toHaveBeenCalledOnce();
    // A second click/replay has no pending action to consume.
    await store.getState().confirmAction();
    expect(fundCredits).toHaveBeenCalledOnce();
  });

  it('cancelling the card leaves an automatically approving wallet unused', async () => {
    await modelCalls(['fund_credits']);
    store.getState().cancelAction();
    await store.getState().confirmAction();
    for (const mutate of mutations) expect(mutate).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 0.0000001, 1.0000001, Number.MAX_SAFE_INTEGER, '50', true])(
    'rejects an unrepresentable credit amount (%s) before and after approval', async (amount) => {
      expect((await executeTool('fund_credits', { amount }, options())).success).toBe(false);
      expect((await executeConfirmedTool('fund_credits', { amount, address: ADDRESS }, options())).success).toBe(false);
      expect(fundCredits).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'User cancelled', new Error('Wallet closed')])('normalizes pre-flight funding cancellation (%s)', async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const opts = { ...options(), signal: controller.signal };
    const args = { amount: 1, address: ADDRESS };
    const cancelled = { success: false, error: 'Credit funding was cancelled before submission.' };
    expect(await executeConfirmedTool('fund_credits', args, opts)).toEqual(cancelled);
    expect(await executeConfirmedFundCredits(args, CLIENT, opts)).toEqual(cancelled);
    expect(fundCredits).not.toHaveBeenCalled();
  });

  it.each([false, true, undefined])('preserves the SDK cancellation verdict (sent=%s)', async (sent) => {
    vi.mocked(fundCredits).mockRejectedValueOnce({ code: 'OPERATION_CANCELLED', details: { sent } });
    const result = await executeConfirmedTool('fund_credits', { amount: 1, address: ADDRESS }, options());
    expect(result.success).toBe(false);
    expect(result.error).toContain(sent === false ? 'cancelled before submission' : 'may have been submitted');
    expect(fundCredits).toHaveBeenCalledOnce();
  });

  it('normalizes SDK and chain failures without reporting a successful credit transfer', async () => {
    vi.mocked(fundCredits).mockRejectedValueOnce(new Error('Gas ceiling exceeded'));
    expect(await executeConfirmedTool('fund_credits', { amount: 1, address: ADDRESS }, options()))
      .toEqual({ success: false, error: 'Gas ceiling exceeded' });
    vi.mocked(fundCredits).mockResolvedValueOnce({ code: 5, rawLog: 'insufficient funds' } as never);
    expect(await executeConfirmedTool('fund_credits', { amount: 1, address: ADDRESS }, options()))
      .toEqual({ success: false, error: 'insufficient funds' });
  });

  const plans = {
    deploy_app: { app_name: 'web', size: 'micro', skuUuid: 'sku', providerUuid: 'provider', providerUrl: 'https://provider.example' },
    stop_app: { app_name: 'web', leaseUuid: 'lease' },
    fund_credits: { amount: 1, address: ADDRESS },
    restart_app: { app_name: 'web', leaseUuid: 'lease', providerUrl: 'https://provider.example' },
    update_app: { app_name: 'web', leaseUuid: 'lease', providerUrl: 'https://provider.example' },
    set_custom_domain: { app_name: 'web', leaseUuid: 'lease', customDomain: 'web.example.com', address: ADDRESS },
  } satisfies { [N in Exclude<TransactionToolName, 'batch_deploy'>]: TransactionPlan<N> };

  it.each(Object.entries(plans))('rejects extra raw transaction or fee fields in %s at planning and confirmation', async (name, plan) => {
    const toolName = name as keyof typeof plans;
    for (const extra of [{ fee: { gas: '999999999', amount: [] } }, { module: 'bank', subcommand: 'send' }, { denomString: '999999umfx' }]) {
      const malicious = { ...plan, ...extra };
      expect(transactionConfirmation(toolName, malicious, 'Approve?').success).toBe(false);
      expect((await executeConfirmedTool(toolName, malicious, options())).success).toBe(false);
    }
    for (const mutate of mutations) expect(mutate).not.toHaveBeenCalled();
  });
});
