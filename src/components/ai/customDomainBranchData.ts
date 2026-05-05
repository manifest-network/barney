/**
 * Data shape + parser for the standalone set_custom_domain confirmation
 * branch. Extracted out of ConfirmationCardCustomDomain.tsx so the .tsx
 * file only exports React components (react-refresh constraint).
 */

import type { PendingAction } from '../../ai/toolExecutor';

export interface CustomDomainBranchData {
  appName: string;
  serviceName: string;
  customDomain: string;
  currentDomain: string;
  expectedCnameTarget?: string;
  warning?: string;
}

/** Extract the strongly-typed CustomDomainBranchData from a PendingAction.
 *  Returns null when the action is not a set_custom_domain TX. */
export function parseCustomDomainArgs(action: PendingAction): CustomDomainBranchData | null {
  if (action.toolName !== 'set_custom_domain') return null;
  const args = action.args;
  return {
    appName: typeof args.app_name === 'string' ? args.app_name : '',
    serviceName: typeof args.serviceName === 'string' ? args.serviceName : '',
    customDomain: typeof args.customDomain === 'string' ? args.customDomain : '',
    currentDomain: typeof args.currentDomain === 'string' ? args.currentDomain : '',
    expectedCnameTarget: typeof args.expectedCnameTarget === 'string' ? args.expectedCnameTarget : undefined,
    warning: typeof args.warning === 'string' ? args.warning : undefined,
  };
}
