/**
 * Argument validation for confirmation-required tools
 */

import { isValidUUID, parseJsonStringArray } from '../../utils/format';

/**
 * Validate required arguments for confirmation-required tools.
 * Returns an error message if validation fails, or null if valid.
 */
export function validateConfirmationToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  address: string | undefined
): string | null {
  // All confirmation-required tools need a connected wallet
  if (!address) {
    return 'Wallet not connected. Please connect your wallet first.';
  }

  switch (toolName) {
    case 'fund_credit': {
      const amount = args.amount as string | undefined;
      if (!amount || typeof amount !== 'string' || amount.trim() === '') {
        return 'Missing required argument: amount. Please specify an amount (e.g., "1000000umfx").';
      }
      // Basic format check - should be digits followed by denomination
      if (!/^\d+[a-zA-Z]/.test(amount)) {
        return `Invalid amount format: "${amount}". Use format like "1000000umfx" or "10000000factory/...".`;
      }
      return null;
    }

    case 'create_lease': {
      const itemsRaw = args.items;
      if (!itemsRaw) {
        return 'Missing required argument: items. Please specify items as a JSON array.';
      }

      let items: unknown[];
      try {
        items = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw as unknown[];
      } catch {
        return `Invalid items format: could not parse JSON. Use format: [{"sku_name": "001", "quantity": 1}]`;
      }

      if (!Array.isArray(items) || items.length === 0) {
        return 'Items must be a non-empty array.';
      }

      // Validate each item has required fields
      for (let i = 0; i < items.length; i++) {
        const item = items[i] as Record<string, unknown>;
        if (!item || typeof item !== 'object') {
          return `Invalid item at index ${i}: must be an object.`;
        }

        const hasName = typeof item.sku_name === 'string' && item.sku_name.length > 0;
        const hasUuid = typeof item.sku_uuid === 'string' && item.sku_uuid.length > 0;

        if (!hasName && !hasUuid) {
          return `Item at index ${i} must have either sku_name or sku_uuid.`;
        }
        if (hasUuid && !isValidUUID(item.sku_uuid as string)) {
          return `Invalid SKU UUID format in item at index ${i}: "${item.sku_uuid}".`;
        }
        if (typeof item.quantity !== 'number' || item.quantity < 1) {
          return `Invalid quantity in item at index ${i}: must be a positive number.`;
        }
      }
      return null;
    }

    case 'close_lease': {
      const leaseUuid = args.lease_uuid as string | undefined;
      if (!leaseUuid || typeof leaseUuid !== 'string' || leaseUuid.trim() === '') {
        return 'Missing required argument: lease_uuid.';
      }
      if (!isValidUUID(leaseUuid)) {
        return `Invalid lease UUID format: "${leaseUuid}". Use format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.`;
      }
      return null;
    }

    case 'cosmos_tx': {
      const module = args.module as string | undefined;
      const subcommand = args.subcommand as string | undefined;
      if (!module || typeof module !== 'string' || module.trim() === '') {
        return 'Missing required argument: module.';
      }
      if (!subcommand || typeof subcommand !== 'string' || subcommand.trim() === '') {
        return 'Missing required argument: subcommand.';
      }

      // Validate args is present and is a JSON array of strings
      const txArgs = args.args;
      if (!txArgs) {
        return 'Missing required argument: args. Please provide a JSON array of string arguments.';
      }

      const parseResult = parseJsonStringArray(txArgs);
      if (parseResult.error) {
        return parseResult.error;
      }

      return null;
    }

    case 'upload_payload': {
      const leaseUuid = args.lease_uuid as string | undefined;
      if (!leaseUuid || typeof leaseUuid !== 'string' || leaseUuid.trim() === '') {
        return 'Missing required argument: lease_uuid.';
      }

      if (!isValidUUID(leaseUuid)) {
        return `Invalid lease UUID format: "${leaseUuid}". Use format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.`;
      }

      const payload = args.payload as string | undefined;
      if (!payload || typeof payload !== 'string' || payload.trim() === '') {
        return 'Missing required argument: payload. Please provide the deployment data to upload.';
      }

      // Note: provider_api_url is no longer accepted - it's derived from on-chain lease data for security
      return null;
    }

    default:
      return null;
  }
}

/**
 * Get a human-readable confirmation message for a tool
 */
export function getConfirmationMessage(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'fund_credit':
      return `Fund your credit account with ${args.amount}?`;
    case 'create_lease': {
      let summary = '';
      try {
        const items = typeof args.items === 'string' ? JSON.parse(args.items) : args.items;
        if (Array.isArray(items) && items.length > 0) {
          const parts = items.map((item: Record<string, unknown>) => {
            const label = item.sku_name || item.sku_uuid || 'unknown';
            return `${item.quantity}x ${label}`;
          });
          summary = parts.join(', ');
        }
      } catch {
        // Fall through to generic message
      }
      return summary
        ? `Create a new lease with ${summary}?`
        : 'Create a new lease?';
    }
    case 'close_lease':
      return `Close lease ${args.lease_uuid}${args.reason ? ` (reason: ${args.reason})` : ''}?`;
    case 'upload_payload':
      return `Upload deployment payload to lease ${args.lease_uuid}?`;
    case 'cosmos_tx':
      return `Execute transaction: ${args.module} ${args.subcommand}?`;
    default:
      return `Execute ${toolName}?`;
  }
}
