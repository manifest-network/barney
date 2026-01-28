/**
 * AI Tool Definitions for the chat assistant
 * These tools enable the AI to interact with the Manifest blockchain
 */

import type { OllamaTool } from '../api/ollama';

export const AI_TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description: 'Get the wallet token balances and credit account status for the connected user',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_leases',
      description: 'List the current user\'s leases. Can filter by state: pending, active, closed, rejected, or expired.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Filter leases by state',
            enum: ['all', 'pending', 'active', 'closed', 'rejected', 'expired'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_providers',
      description: 'List all available compute providers in the catalog',
      parameters: {
        type: 'object',
        properties: {
          active_only: {
            type: 'string',
            description: 'If "true", only return active providers',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_skus',
      description: 'List SKUs (compute resources) offered by a specific provider',
      parameters: {
        type: 'object',
        properties: {
          provider_uuid: {
            type: 'string',
            description: 'The UUID of the provider to get SKUs for',
          },
        },
        required: ['provider_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_credit_estimate',
      description: 'Get the estimated remaining time for the credit account based on current burn rate',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_lease',
      description: 'Create a new lease for compute resources. IMPORTANT: Requires user confirmation. CRITICAL: You MUST call get_providers then get_skus FIRST to obtain valid SKU UUIDs. SKU UUIDs are formatted like "019beb87-09de-7000-beef-ae733e73ff23". Never use user-provided names like "001" or "SKU-001" as the UUID - always query for the real UUID first. If deployment_data is provided, the meta_hash will be automatically computed from it.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'string',
            description: 'JSON array of items to lease. IMPORTANT: sku_uuid must be a valid UUID obtained from get_skus (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Example: [{"sku_uuid": "019beb87-09de-7000-beef-ae733e73ff23", "quantity": 1}]',
          },
          deployment_data: {
            type: 'string',
            description: 'CRITICAL: Use the EXACT payload the user provided - do NOT invent or modify it. If user says "with payload {\"hello\": \"mom\"}", then deployment_data must be exactly "{\"hello\": \"mom\"}". Never make up deployment data.',
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_payload',
      description: 'Upload deployment payload data to a provider for an existing PENDING lease. This requires a lease that was created with a meta_hash. The payload hash must match the meta_hash stored on-chain. The provider API URL is automatically derived from the lease for security. IMPORTANT: Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          lease_uuid: {
            type: 'string',
            description: 'The UUID of the PENDING lease to upload data for',
          },
          payload: {
            type: 'string',
            description: 'The deployment payload data (YAML/JSON) to upload to the provider',
          },
        },
        required: ['lease_uuid', 'payload'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_lease',
      description: 'Close an active lease. IMPORTANT: This will require user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          lease_uuid: {
            type: 'string',
            description: 'The UUID of the lease to close',
          },
          reason: {
            type: 'string',
            description: 'Optional reason for closing the lease',
          },
        },
        required: ['lease_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fund_credit',
      description: 'Add funds to the credit account. IMPORTANT: This will require user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'string',
            description: 'Amount to fund in format "<micro_amount><denom>". Examples: "10000000umfx" for 10 MFX, "10000000factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr" for 10 PWR. Always multiply display amount by 1,000,000.',
          },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_withdrawable',
      description: 'Check the withdrawable amount for a specific lease',
      parameters: {
        type: 'object',
        properties: {
          lease_uuid: {
            type: 'string',
            description: 'The UUID of the lease to check',
          },
        },
        required: ['lease_uuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cosmos_query',
      description: 'Execute any Cosmos SDK query. Use this for advanced queries not covered by other tools.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, distribution, gov, auth, billing)',
          },
          subcommand: {
            type: 'string',
            description: 'The query subcommand',
          },
          args: {
            type: 'string',
            description: 'JSON array of string arguments',
          },
        },
        required: ['module', 'subcommand'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cosmos_tx',
      description: 'Execute any Cosmos SDK transaction. IMPORTANT: This will require user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, distribution, gov, billing)',
          },
          subcommand: {
            type: 'string',
            description: 'The transaction subcommand',
          },
          args: {
            type: 'string',
            description: 'JSON array of string arguments',
          },
        },
        required: ['module', 'subcommand', 'args'],
      },
    },
  },
];

/**
 * Tools that require user confirmation before execution
 */
export const CONFIRMATION_REQUIRED_TOOLS = new Set([
  'create_lease',
  'close_lease',
  'fund_credit',
  'cosmos_tx',
  'upload_payload',
]);

/**
 * Check if a tool requires confirmation
 */
export function requiresConfirmation(toolName: string): boolean {
  return CONFIRMATION_REQUIRED_TOOLS.has(toolName);
}

/**
 * Set of valid tool names derived from AI_TOOLS to ensure consistency
 */
export const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(
  AI_TOOLS.map((tool) => tool.function.name)
);

/**
 * Check if a tool name is valid
 */
export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && VALID_TOOL_NAMES.has(name);
}

/**
 * Get a human-readable description for a tool call
 */
export function getToolCallDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'get_balance':
      return 'Checking your wallet balance and credit account...';
    case 'get_leases':
      return args.state ? `Fetching your ${args.state} leases...` : 'Fetching your leases...';
    case 'get_providers':
      return 'Listing available providers...';
    case 'get_skus':
      return `Getting SKUs for provider ${args.provider_uuid}...`;
    case 'get_credit_estimate':
      return 'Calculating credit estimate...';
    case 'create_lease':
      return args.deployment_data
        ? 'Creating a new lease with deployment data (requires confirmation)'
        : 'Creating a new lease (requires confirmation)';
    case 'upload_payload':
      return `Uploading deployment payload to lease ${args.lease_uuid} (requires confirmation)`;
    case 'close_lease':
      return `Closing lease ${args.lease_uuid} (requires confirmation)`;
    case 'fund_credit':
      return `Funding credit account with ${args.amount} (requires confirmation)`;
    case 'get_withdrawable':
      return `Checking withdrawable amount for lease ${args.lease_uuid}...`;
    case 'cosmos_query':
      return `Querying ${args.module} ${args.subcommand}...`;
    case 'cosmos_tx':
      return `Executing ${args.module} ${args.subcommand} (requires confirmation)`;
    default:
      return `Executing ${toolName}...`;
  }
}
