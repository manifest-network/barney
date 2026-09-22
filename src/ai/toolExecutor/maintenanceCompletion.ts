import { runtimeConfig } from '../../config/runtimeConfig';
import type { MaintenanceOperation } from './maintenanceOperation';
import type { ToolResult } from './types';

export type MaintenanceResult = {
  outcome: 'succeeded' | 'failed' | 'unconfirmed' | 'cancelled';
  result: ToolResult;
  url?: string;
};

type CommandIdentity = Pick<MaintenanceOperation, 'address' | 'providerUrl' | 'leaseUuid' | 'operation' | 'idempotencyKey' | 'chainId'>;

// Repeated confirmations must not observe a settled command against a new
// release baseline. Retain only its fingerprint and public result, never bytes.
const completed = new Map<string, { result: MaintenanceResult; payloadHash: string }>();

function completionKey(command: CommandIdentity): string {
  return JSON.stringify([
    command.chainId, runtimeConfig.PUBLIC_RPC_URL, runtimeConfig.PUBLIC_REST_URL,
    command.address.trim().toLowerCase(), new URL(command.providerUrl).href.replace(/\/+$/, ''),
    command.leaseUuid, command.operation, command.idempotencyKey,
  ]);
}

export function getCompletedMaintenance(command: CommandIdentity) {
  return completed.get(completionKey(command));
}

export function rememberMaintenanceCompletion(command: MaintenanceOperation, result: MaintenanceResult): void {
  completed.set(completionKey(command), { result, payloadHash: command.payloadHash });
}
