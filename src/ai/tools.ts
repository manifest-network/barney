/**
 * AI Tool Definitions
 *
 * 17 tools: 6 TX (require confirmation), 9 query, 2 escape hatch.
 * Model does intent classification; code does orchestration.
 *
 * `AI_TOOLS` is the static base list — it's the single source of truth for
 * `VALID_TOOL_NAMES`, `TOOL_PUBLIC_PARAMS`, and `getDisplaySafeArgs`, none of
 * which depend on the resolved SKU tier list. Use `buildAITools(tiers)` when
 * sending the schema to the model so `deploy_app.size.enum` reflects the
 * currently-resolved tier list. Until tiers resolve, `buildAITools([])` returns
 * the schema without a size enum constraint — the executor handles rejection
 * with a clean "Tier catalog unavailable" error.
 */

import type { ToolDefinition } from '../api/morpheus';
import type { ResolvedSkuTier } from '../api/skuTiers';

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
            description: 'Resource tier (SKU name, e.g. "docker-micro"). Applies to all services in a stack. The exact set of valid tier names is resolved at runtime from chain; see the size enum on this schema.',
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
          custom_domain: {
            type: 'string',
            description: 'Optional FQDN to attach to the lease item right after the create-lease TX confirms. The set-domain TX is broadcast before the manifest upload so Traefik has the domain available when provisioning the container.',
          },
          service_name: {
            type: 'string',
            description: 'Service to target inside a multi-service stack. Required when "services" is provided alongside "custom_domain" (deploy + attach in one step), and used by the set_custom_domain tool as the per-LeaseItem picker. Must match one of the service keys. Omit for image+port single-service deploys.',
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

  {
    type: 'function',
    function: {
      name: 'set_custom_domain',
      description: 'Attach or clear a custom DNS domain (e.g. "app.example.com") on a deployed app. Pass an empty string for custom_domain to clear an existing domain. For multi-service stacks, the AI must pick service_name from the stack\'s services.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: 'The app name to attach the domain to.',
          },
          custom_domain: {
            type: 'string',
            description: 'Fully qualified domain name (e.g. "app.example.com"). Empty string clears the existing custom domain.',
          },
          service_name: {
            type: 'string',
            description: 'For multi-service stacks: which service the domain applies to. Omit for single-service apps.',
          },
        },
        required: ['app_name', 'custom_domain'],
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
      description:
        'Browse providers and resource tiers. Each provider row carries health_status, the provider\'s own three-tier verdict: "healthy" (fully serving), "degraded" (still serving, but a shared dependency such as the chain or a backend is impaired, so deploys and other lease operations there may fail), or "unhealthy" (a provider-local store is broken). Rows may also read "unreachable" or "no_api_url" when no verdict came back, and a newer provider may report a value not listed here — report whatever it says verbatim. Only "healthy" sets healthy=true. When present, healthError names the specific checks that failed.',
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
      description: 'Request free PWR (gas + credits) and MFX tokens from the faucet. 24-hour cooldown per token.',
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
  'set_custom_domain',
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

/** Lookup table of tool name → declared user-facing parameter keys.
 *  Used by ConfirmationCard to filter `pendingAction.args` for display. */
const TOOL_PUBLIC_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  AI_TOOLS.map((tool) => [
    tool.function.name,
    new Set(Object.keys(tool.function.parameters.properties)),
  ]),
);

/**
 * Filter `pendingAction.args` to the keys that the AI tool's public schema
 * declares. Internal-only fields stuffed into `args` by executors (skuUuid,
 * providerUrl, _generatedManifest, customDomainServiceName, ...) are dropped.
 *
 * The AI tool schema in `AI_TOOLS` is the single source of truth — adding a
 * new internal arg requires no other change; adding a new *public* arg
 * automatically surfaces it in the confirmation card.
 *
 * Unknown tool names (e.g. internal `batch_deploy`) return an empty record so
 * nothing leaks to the user.
 */
export function getDisplaySafeArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const publicKeys = TOOL_PUBLIC_PARAMS.get(toolName);
  if (!publicKeys) return {};
  const out: Record<string, unknown> = {};
  for (const k of publicKeys) {
    if (k in args && args[k] !== undefined) out[k] = args[k];
  }
  return out;
}

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
      const domain = typeof args.custom_domain === 'string' && args.custom_domain ? ` with custom domain ${args.custom_domain}` : '';
      if (args.services) {
        return `Deploying stack${name}${size}${domain}...`;
      }
      const image = !args.app_name && args.image ? ` from ${args.image}` : '';
      return `Deploying app${name}${image}${size}${domain}...`;
    }
    case 'stop_app': {
      const stopName = String(args.app_name ?? '').trim();
      if (stopName.toLowerCase() === 'all') return 'Stopping all apps...';
      if (stopName.includes(',')) return `Stopping apps ${stopName}...`;
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
      const restartName = String(args.app_name ?? '').trim();
      if (restartName.toLowerCase() === 'all') return 'Restarting all apps...';
      if (restartName.includes(',')) return `Restarting apps ${restartName}...`;
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
    case 'set_custom_domain': {
      const domain = String(args.custom_domain ?? '').trim();
      const target = String(args.app_name ?? '').trim();
      if (domain === '') return `Clearing custom domain for "${target}"...`;
      return `Setting custom domain "${domain}" for "${target}"...`;
    }
    case 'cosmos_query':
      return `Querying ${args.module} ${args.subcommand}...`;
    case 'cosmos_tx':
      return `Executing ${args.module} ${args.subcommand} (requires confirmation)`;
    default:
      return `Executing ${toolName}...`;
  }
}

/**
 * Build the AI tool schema with the deploy_app.size enum sourced from the
 * resolved tier list. Pass an empty array (loading/error states) to omit the
 * enum constraint entirely — the executor will reject the tool invocation
 * with a "Tier catalog unavailable" message before broadcasting anything.
 */
export function buildAITools(tiers: readonly ResolvedSkuTier[]): ToolDefinition[] {
  return AI_TOOLS.map((tool) => {
    if (tool.function.name !== 'deploy_app') return tool;
    if (tiers.length === 0) return tool;
    const props = tool.function.parameters.properties;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...tool.function.parameters,
          properties: {
            ...props,
            size: {
              ...props.size,
              enum: tiers.map((t) => t.skuName),
            },
          },
        },
      },
    };
  });
}
