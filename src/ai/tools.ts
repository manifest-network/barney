/**
 * AI Tool Definitions
 *
 * 15 tools: 5 TX (require confirmation), 8 query, 2 escape hatch.
 * Model does intent classification; code does orchestration.
 */

import type { OllamaTool } from '../api/ollama';

export const AI_TOOLS: OllamaTool[] = [
  // --- TX tools (require confirmation) ---
  {
    type: 'function',
    function: {
      name: 'deploy_app',
      description: 'Deploy an app from an attached manifest file, or by specifying a Docker image.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'App name. Derived from filename or image if omitted.',
          },
          size: {
            type: 'string',
            description: 'Resource tier: micro, small, medium, or large.',
            enum: ['micro', 'small', 'medium', 'large'],
          },
          image: {
            type: 'string',
            description: 'Docker image (e.g. "redis:8.4"). Used when no file attached.',
          },
          port: {
            type: 'string',
            description: 'Port(s) to expose, comma-separated (e.g. "6379"). Defaults to tcp.',
          },
          env: {
            type: 'string',
            description: 'Env vars as JSON string (e.g. \'{"KEY":"value"}\'). Empty values auto-generate passwords.',
          },
          user: {
            type: 'string',
            description: 'Container user/UID (e.g. "999:999").',
          },
          tmpfs: {
            type: 'string',
            description: 'Tmpfs mount paths, comma-separated (e.g. "/var/run/postgresql").',
          },
          command: {
            type: 'string',
            description: 'JSON array for container entrypoint override, e.g. \'["sh", "-c"]\'.',
          },
          args: {
            type: 'string',
            description: 'JSON array for container command/args override, e.g. \'["echo hello"]\'.',
          },
          storage: {
            type: 'boolean',
            description: 'Set to true for apps that need persistent disk (databases, etc.).',
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
      description: 'Stop an app by name, or "all" to stop all.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the app to stop, or "all" to stop all running apps.',
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
      description: 'Add credits to your account.',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Amount of credits to add (e.g., 50).',
          },
        },
        required: ['amount'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'restart_app',
      description: 'Restart a running app.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the app to restart.',
          },
        },
        required: ['app_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_app',
      description: 'Update an app with a new manifest file, or by specifying a new Docker image.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the app to update.',
          },
          image: {
            type: 'string',
            description: 'New Docker image to update to (e.g. "redis:8"). Used when no file attached.',
          },
          port: {
            type: 'string',
            description: 'Port(s) to expose, comma-separated. Only needed with image.',
          },
          env: {
            type: 'string',
            description: 'Env vars as JSON string. Only needed with image.',
          },
          user: {
            type: 'string',
            description: 'Container user/UID. Only needed with image.',
          },
          tmpfs: {
            type: 'string',
            description: 'Tmpfs mount paths, comma-separated. Only needed with image.',
          },
          command: {
            type: 'string',
            description: 'JSON array for container entrypoint override. Only needed with image.',
          },
          args: {
            type: 'string',
            description: 'JSON array for container command/args override. Only needed with image.',
          },
        },
        required: ['app_name'],
      },
    },
  },

  // --- Query tools ---
  {
    type: 'function',
    function: {
      name: 'list_apps',
      description: 'List deployed apps, optionally filtered by state.',
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
      description: 'Get status of a running app.',
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
      name: 'get_logs',
      description: 'Get container logs for an app.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The app name to get logs for.',
          },
          tail: {
            type: 'number',
            description: 'Number of log lines to return. Default: 100.',
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
      description: 'Get credit balance and spending rate.',
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
      description: 'Browse providers and resource tiers.',
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
      name: 'lease_history',
      description: 'List past lease history with pagination.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Filter by state. Default: all. Note: use "stopped" when speaking to the user, but pass "closed" here.',
            enum: ['all', 'pending', 'active', 'closed', 'rejected', 'expired'],
          },
          limit: {
            type: 'number',
            description: 'Max number of leases to return per page. Default: 10.',
          },
          offset: {
            type: 'number',
            description: 'Number of leases to skip (for pagination). Default: 0.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'app_diagnostics',
      description: 'Get error details for a failed app.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The app name to diagnose.',
          },
        },
        required: ['app_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'app_releases',
      description: 'Get release history for an app.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The app name to get releases for.',
          },
        },
        required: ['app_name'],
      },
    },
  },

  // --- Escape hatch ---
  {
    type: 'function',
    function: {
      name: 'cosmos_query',
      description: 'Execute a raw Cosmos SDK query.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, gov, auth, billing, sku, provider)',
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
      description: 'Execute a raw Cosmos SDK transaction.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'The module name (bank, staking, gov, billing)',
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
  'restart_app',
  'update_app',
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
      const image = !args.app_name && args.image ? ` from ${args.image}` : '';
      return `Deploying app${name}${image}${size}...`;
    }
    case 'stop_app':
      return args.app_name === 'all' ? 'Stopping all apps...' : `Stopping app "${args.app_name}"...`;
    case 'fund_credits':
      return `Funding credits with ${args.amount} PWR...`;
    case 'list_apps':
      return args.state ? `Listing ${args.state} apps...` : 'Listing running apps...';
    case 'app_status':
      return `Checking status of "${args.app_name}"...`;
    case 'get_logs':
      return `Fetching logs for "${args.app_name}"...`;
    case 'get_balance':
      return 'Checking your balance and credits...';
    case 'browse_catalog':
      return 'Browsing available tiers and providers...';
    case 'lease_history':
      return args.state && args.state !== 'all'
        ? `Fetching ${args.state} lease history...`
        : 'Fetching lease history...';
    case 'restart_app':
      return `Restarting app "${args.app_name}"...`;
    case 'update_app':
      return `Updating app "${args.app_name}"...`;
    case 'app_diagnostics':
      return `Fetching diagnostics for "${args.app_name}"...`;
    case 'app_releases':
      return `Fetching releases for "${args.app_name}"...`;
    case 'cosmos_query':
      return `Querying ${args.module} ${args.subcommand}...`;
    case 'cosmos_tx':
      return `Executing ${args.module} ${args.subcommand} (requires confirmation)`;
    default:
      return `Executing ${toolName}...`;
  }
}
