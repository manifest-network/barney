/**
 * AI Tool Definitions
 *
 * 16 tools: 5 TX (require confirmation), 9 query, 2 escape hatch.
 * Model does intent classification; code does orchestration.
 */

import type { ToolDefinition } from '../api/morpheus';

export const AI_TOOLS: ToolDefinition[] = [
  // --- TX tools (require confirmation) ---
  {
    type: 'function',
    function: {
      name: 'deploy_app',
      description: 'Deploy an app from an attached manifest file, a Docker image, or a service stack. For stacks (multi-service deploys like app+database), use the "services" parameter instead of "image".',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'App name. Derived from filename or image if omitted.',
          },
          size: {
            type: 'string',
            description: 'Resource tier: micro, small, medium, or large. Applies to all services in a stack.',
            enum: ['micro', 'small', 'medium', 'large'],
          },
          image: {
            type: 'string',
            description: 'Docker image (e.g. "redis:8.4"). Used for single-service deploy when no file attached. Mutually exclusive with "services".',
          },
          port: {
            type: 'string',
            description: 'Port(s) to expose, comma-separated (e.g. "6379"). Defaults to tcp. Only with "image".',
          },
          env: {
            type: 'string',
            description: 'Env vars as JSON string (e.g. \'{"KEY":"value"}\'). Empty values auto-generate passwords. Only with "image".',
          },
          user: {
            type: 'string',
            description: 'Container user/UID (e.g. "999:999"). Only with "image".',
          },
          tmpfs: {
            type: 'string',
            description: 'Tmpfs mount paths, comma-separated (e.g. "/var/run/postgresql"). Only with "image".',
          },
          command: {
            type: 'string',
            description: 'JSON array for container entrypoint override, e.g. \'["sh", "-c"]\'. Only with "image".',
          },
          args: {
            type: 'string',
            description: 'JSON array for container command/args override, e.g. \'["echo hello"]\'. Only with "image".',
          },
          storage: {
            type: 'boolean',
            description: 'Set to true for apps that need persistent disk (databases, etc.).',
          },
          services: {
            type: 'string',
            description: 'JSON object for multi-service stack deploys. Mutually exclusive with "image". Format: \'{"web":{"image":"nginx","port":"80"},"db":{"image":"postgres","port":"5432","env":{"POSTGRES_PASSWORD":""}}}\'.',
          },
          health_check: {
            type: 'string',
            description: 'Health check config as JSON (e.g. \'{"test":["CMD-SHELL","curl -f http://localhost/health"],"interval":"30s","timeout":"5s","retries":3,"start_period":"10s"}\').',
          },
          stop_grace_period: {
            type: 'string',
            description: 'Grace period before SIGKILL after SIGTERM (e.g. "30s"). Range: 1s-120s.',
          },
          init: {
            type: 'boolean',
            description: 'Run init process (tini) as PID 1 for zombie reaping.',
          },
          expose: {
            type: 'string',
            description: 'Inter-service ports to document, comma-separated (e.g. "3000,9090"). Does not create host bindings.',
          },
          labels: {
            type: 'string',
            description: 'Container labels as JSON (e.g. \'{"app":"myapp"}\').',
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
      description: 'Stop apps by name, comma-separated list, or "all" to stop all.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'App name, comma-separated names (e.g. "redis,postgres"), or "all" to stop all running apps.',
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
      description: 'Restart apps by name, comma-separated list, or "all" to restart all.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'App name, comma-separated names (e.g. "redis,postgres"), or "all" to restart all running apps.',
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
      description: 'Update an app with a new manifest file, a new Docker image, or a new service stack definition.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The name of the app to update.',
          },
          image: {
            type: 'string',
            description: 'New Docker image to update to (e.g. "redis:8"). Used when no file attached. Mutually exclusive with "services".',
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
          services: {
            type: 'string',
            description: 'JSON object for multi-service stack updates. Mutually exclusive with "image". Same format as deploy_app services.',
          },
          health_check: {
            type: 'string',
            description: 'Health check config as JSON (e.g. \'{"test":["CMD-SHELL","curl -f http://localhost/health"],"interval":"30s","timeout":"5s","retries":3,"start_period":"10s"}\').',
          },
          stop_grace_period: {
            type: 'string',
            description: 'Grace period before SIGKILL after SIGTERM (e.g. "30s"). Range: 1s-120s.',
          },
          init: {
            type: 'boolean',
            description: 'Run init process (tini) as PID 1 for zombie reaping.',
          },
          expose: {
            type: 'string',
            description: 'Inter-service ports to document, comma-separated (e.g. "3000,9090"). Does not create host bindings.',
          },
          labels: {
            type: 'string',
            description: 'Container labels as JSON (e.g. \'{"app":"myapp"}\').',
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

  {
    type: 'function',
    function: {
      name: 'request_faucet',
      description: 'Request free MFX (gas) and PWR (credits) tokens from the faucet. 24-hour cooldown per token.',
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
      if (args.services) {
        return `Deploying stack${name}${size}...`;
      }
      const image = !args.app_name && args.image ? ` from ${args.image}` : '';
      return `Deploying app${name}${image}${size}...`;
    }
    case 'stop_app': {
      const stopName = args.app_name as string;
      if (stopName === 'all') return 'Stopping all apps...';
      if (typeof stopName === 'string' && stopName.includes(',')) return `Stopping apps ${stopName}...`;
      return `Stopping app "${stopName}"...`;
    }
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
    case 'restart_app': {
      const restartName = args.app_name as string;
      if (restartName === 'all') return 'Restarting all apps...';
      if (typeof restartName === 'string' && restartName.includes(',')) return `Restarting apps ${restartName}...`;
      return `Restarting app "${restartName}"...`;
    }
    case 'update_app':
      return args.services ? `Updating stack "${args.app_name}"...` : `Updating app "${args.app_name}"...`;
    case 'app_diagnostics':
      return `Fetching diagnostics for "${args.app_name}"...`;
    case 'app_releases':
      return `Fetching releases for "${args.app_name}"...`;
    case 'request_faucet':
      return 'Requesting tokens from faucet...';
    case 'cosmos_query':
      return `Querying ${args.module} ${args.subcommand}...`;
    case 'cosmos_tx':
      return `Executing ${args.module} ${args.subcommand} (requires confirmation)`;
    default:
      return `Executing ${toolName}...`;
  }
}
