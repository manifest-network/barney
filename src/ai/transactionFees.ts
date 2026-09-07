import { calculateFee } from '@cosmjs/stargate';
import { GAS_PRICE } from '../config/chain';
import { MAX_TRANSACTION_GAS } from '../config/constants';

export interface TransactionFeeLimit {
  maxGasPerTransaction: number;
  maxTransactions: number;
  amount: string;
  denom: string;
}

/** Deploy consent includes an optional domain transaction; provider-only
 * restart/update operations do not pay chain fees. Never accept fee overrides
 * from tool arguments: the wallet manager enforces this same local policy. */
export function getTransactionFeeLimit(
  toolName: string,
  args: Record<string, unknown>,
): TransactionFeeLimit | null {
  let maxTransactions: number;
  switch (toolName) {
    case 'deploy_app':
      maxTransactions = 2;
      break;
    case 'batch_deploy': {
      const plan = args.plan as { entries?: unknown[] } | undefined;
      maxTransactions = Array.isArray(plan?.entries) ? 2 * plan.entries.length : 0;
      break;
    }
    case 'stop_app':
      maxTransactions = Array.isArray(args.entries) ? args.entries.length : 1;
      break;
    case 'fund_credits':
    case 'set_custom_domain':
      maxTransactions = 1;
      break;
    default:
      return null;
  }
  if (maxTransactions === 0) return null;
  const [fee] = calculateFee(MAX_TRANSACTION_GAS, GAS_PRICE).amount;
  return {
    maxGasPerTransaction: MAX_TRANSACTION_GAS,
    maxTransactions,
    amount: (BigInt(fee.amount) * BigInt(maxTransactions)).toString(),
    denom: fee.denom,
  };
}
