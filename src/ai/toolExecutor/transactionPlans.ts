import { z } from 'zod';
import { DENOMS } from '../../api/config';
import { toBaseUnits } from '../../utils/format';
import { validateCustomDomainFormat } from '../../utils/customDomainValidation';
import { isBatchDeployPlan, type BatchDeployPlan } from './batchDeployPlan';
import type { ToolResult } from './types';

const name = z.string().trim().min(1);
const providerUrl = z.url();
const domain = z.string({ error: 'customDomain must be a string (use "" to clear).' }).refine(
  (value) => value === '' || validateCustomDomainFormat(value) === null,
  'Invalid custom domain.',
);

export const creditAmountSchema = z.number().positive('Amount must be a positive number.').refine(
  (amount) => {
    const baseUnits = Number(toBaseUnits(amount, DENOMS.PWR));
    return Number.isSafeInteger(baseUnits) && baseUnits > 0 && baseUnits / 1_000_000 === amount;
  },
  'Amount must use at most 6 decimal places and fit in safe integer base units.',
);

const stopEntry = z.strictObject({ app_name: name, leaseUuid: name });
const restartEntry = stopEntry.extend({ providerUrl });

/** The semantic action shown for approval and parsed again before execution.
 * Unknown fields fail closed, including caller-supplied fees or raw TX data.
 * Batch deploy additionally revalidates its exact manifest/price/plan hashes. */
const transactionPlanSchemas = {
  deploy_app: z.strictObject({
    app_name: name,
    size: name,
    skuUuid: name,
    providerUuid: name,
    providerUrl,
    _generatedManifest: z.string().optional(),
    _serviceNames: z.array(name).min(1).optional(),
    customDomain: domain.optional(),
    customDomainServiceName: z.string().optional(),
    customDomainWarning: z.string().optional(),
  }),
  stop_app: z.union([
    stopEntry,
    z.strictObject({ app_name: name, entries: z.array(stopEntry).min(1) }),
  ]),
  fund_credits: z.strictObject({ amount: creditAmountSchema, address: name }),
  restart_app: z.union([
    restartEntry,
    z.strictObject({ app_name: name, entries: z.array(restartEntry).min(1) }),
  ]),
  update_app: restartEntry.extend({
    _generatedManifest: z.string().optional(),
    _isStack: z.boolean().optional(),
  }),
  set_custom_domain: z.strictObject({
    app_name: name,
    leaseUuid: name,
    serviceName: z.string().optional(),
    customDomain: domain,
    currentDomain: z.string().optional(),
    expectedCnameTarget: z.string().optional(),
    warning: z.string().optional(),
    address: name.optional(),
  }),
  batch_deploy: z.strictObject({
    plan: z.custom<BatchDeployPlan>(isBatchDeployPlan, 'Invalid batch deployment plan.'),
  }),
};

export type TransactionToolName = keyof typeof transactionPlanSchemas;
export type TransactionPlan<N extends TransactionToolName> = z.output<typeof transactionPlanSchemas[N]>;

export function parseTransactionPlan<N extends TransactionToolName>(toolName: N, args: unknown):
  | { success: true; data: TransactionPlan<N> }
  | { success: false; error: string } {
  const result = transactionPlanSchemas[toolName].safeParse(args);
  if (!result.success) {
    return {
      success: false,
      error: `Invalid ${toolName} confirmation: ${result.error.issues.map((issue) =>
        `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`
      ).join('; ')}`,
    };
  }
  return { success: true, data: result.data as TransactionPlan<N> };
}

function freezePlan<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePlan(child);
    Object.freeze(value);
  }
  return value;
}

export function transactionConfirmation<N extends TransactionToolName>(
  toolName: N,
  args: TransactionPlan<N>,
  confirmationMessage: string,
): ToolResult {
  const result = parseTransactionPlan(toolName, args);
  if (!result.success) return result;
  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage,
    pendingAction: { toolName, args: freezePlan(result.data) },
  };
}
