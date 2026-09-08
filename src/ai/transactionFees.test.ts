import { describe, expect, it, vi } from 'vitest';
import { getTransactionFeeLimit } from './transactionFees';
import { MAX_TRANSACTION_GAS } from '../config/constants';

vi.mock('../config/chain', () => ({ GAS_PRICE: '0.0025factory/test/upwr' }));

describe('transaction fee ceilings', () => {
  it.each(['fund_credits', 'set_custom_domain', 'stop_app'])('bounds %s using the wallet gas ceiling and configured price', (tool) => {
    expect(getTransactionFeeLimit(tool, { fee: { amount: '999999999' } })).toEqual({
      maxGasPerTransaction: MAX_TRANSACTION_GAS,
      maxTransactions: 1,
      amount: '125000',
      denom: 'factory/test/upwr',
    });
  });

  it('includes the optional domain transaction and sums batch fees', () => {
    expect(getTransactionFeeLimit('deploy_app', {})).toMatchObject({ amount: '250000', maxTransactions: 2 });
    expect(getTransactionFeeLimit('batch_deploy', { plan: { entries: [{}, {}, {}] } }))
      .toMatchObject({ amount: '750000', maxTransactions: 6 });
    expect(getTransactionFeeLimit('stop_app', { entries: [{}, {}, {}] }))
      .toMatchObject({ amount: '375000', maxTransactions: 3 });
  });

  it.each(['restart_app', 'update_app', 'unregistered_tool'])('does not charge a chain fee for %s', (tool) => {
    expect(getTransactionFeeLimit(tool, {})).toBeNull();
  });
});
