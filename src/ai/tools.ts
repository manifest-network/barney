/**
 * AI Tool Definitions
 *
 * 9 tools: 3 TX (require confirmation), 4 query, 2 escape hatch.
 * Model does intent classification; code does orchestration.
 */

import type { OllamaTool } from '../api/ollama';

export const AI_TOOLS: OllamaTool[] = [
  // --- TX tools (require confirmation) ---
  {
    type: 'function',
    function: {
      name: 'deploy_app',
      description:
        'Deploy an app from an attached manifest file. Requires a file attachment. Defaults size to "small" if not specified. Name is derived from filename if omitted.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'App name (lowercase, alphanumeric + hyphens, 1-32 chars). Derived from filename if omitted.',
          },
          size: {
            type: 'string',
            description: 'Resource tier: small, medium, large, or gpu.',
            enum: ['small', 'medium', 'large', 'gpu'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_app',
      description: 'Stop a running app by name. This closes the lease on-chain.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the app to stop.',
          },
        },
        required: ['app_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fund_credits',
      description:
        'Add credits to your account. Amount is in display units (e.g., 50 means 50 PWR).',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Amount in display units (e.g., 50 for 50 PWR).',
          },
        },
        required: ['amount'],
      },
    },
  },

  // --- Query tools ---
  {
    type: 'function',
    function: {
      name: 'list_apps',
      description: 'List your deployed apps. Can filter by state.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Filter: all, running, stopped, failed, deploying. Default: running.',
            enum: ['all', 'running', 'stopped', 'failed', 'deploying'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'app_status',
      description: 'Get detailed status for a specific app by name.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The app name to check.',
          },
        },
        required: ['app_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description: 'Get your credits, spending rate, and estimated time remaining.',
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
      name: 'browse_catalog',
      description: 'Browse available providers and resource tiers.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // --- Escape hatch ---
  {
    type: 'function',
    function: {
      name: 'cosmos_query',
      description: 'Execute any Cosmos SDK query. For advanced queries not covered by other tools.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, distribution, gov, auth, billing, sku)',
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
      description: 'Execute any Cosmos SDK transaction. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, distribution, gov, billing, sku, manifest)',
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
export const CONFIRMATION_TOOLS = new Set([
  'deploy_app',
  'stop_app',
  'fund_credits',
  'cosmos_tx',
]);

export function requiresConfirmation(toolName: string): boolean {
  return CONFIRMATION_TOOLS.has(toolName);
}

/**
 * Set of valid tool names
 */
export const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(
  AI_TOOLS.map((tool) => tool.function.name)
);

export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && VALID_TOOL_NAMES.has(name);
}

/**
 * Human-readable description for tool calls
 */
export function getToolCallDescription(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case 'deploy_app': {
      const name = args.app_name ? ` "${args.app_name}"` : '';
      const size = args.size ? ` (${args.size})` : '';
      return `Deploying app${name}${size}...`;
    }
    case 'stop_app':
      return `Stopping app "${args.app_name}"...`;
    case 'fund_credits':
      return `Funding credits with ${args.amount} PWR...`;
    case 'list_apps':
      return args.state ? `Listing ${args.state} apps...` : 'Listing running apps...';
    case 'app_status':
      return `Checking status of "${args.app_name}"...`;
    case 'get_balance':
      return 'Checking your balance and credits...';
    case 'browse_catalog':
      return 'Browsing available tiers and providers...';
    case 'cosmos_query':
      return `Querying ${args.module} ${args.subcommand}...`;
    case 'cosmos_tx':
      return `Executing ${args.module} ${args.subcommand} (requires confirmation)`;
    default:
      return `Executing ${toolName}...`;
  }
}
