import { describe, it, expect } from 'vitest';
import {
  requiresConfirmation,
  isValidToolName,
  getToolCallDescription,
  getDisplaySafeArgs,
  AI_TOOLS,
  CONFIRMATION_TOOLS,
  buildAITools,
} from './tools';
import type { ResolvedSkuTier } from '../api/skuTiers';

const SAMPLE_TIERS: ResolvedSkuTier[] = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'b', providerUuid: 'p', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
];

describe('requiresConfirmation', () => {
  it('returns true for all TX tools', () => {
    expect(requiresConfirmation('deploy_app')).toBe(true);
    expect(requiresConfirmation('stop_app')).toBe(true);
    expect(requiresConfirmation('fund_credits')).toBe(true);
    expect(requiresConfirmation('restart_app')).toBe(true);
    expect(requiresConfirmation('update_app')).toBe(true);
    expect(requiresConfirmation('cosmos_tx')).toBe(true);
  });

  it('returns false for all query tools', () => {
    const queryTools = AI_TOOLS.map((t) => t.function.name).filter(
      (name) => !CONFIRMATION_TOOLS.has(name)
    );
    for (const tool of queryTools) {
      expect(requiresConfirmation(tool)).toBe(false);
    }
  });

  it('returns false for unknown tool names', () => {
    expect(requiresConfirmation('unknown_tool')).toBe(false);
    expect(requiresConfirmation('')).toBe(false);
  });
});

describe('isValidToolName', () => {
  it('returns true for every tool in AI_TOOLS', () => {
    for (const tool of AI_TOOLS) {
      expect(isValidToolName(tool.function.name)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isValidToolName('nonexistent_tool')).toBe(false);
    expect(isValidToolName('')).toBe(false);
  });

  it('returns false for case variations', () => {
    expect(isValidToolName('Deploy_App')).toBe(false);
    expect(isValidToolName('GET_BALANCE')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(isValidToolName(null)).toBe(false);
    expect(isValidToolName(undefined)).toBe(false);
    expect(isValidToolName(123)).toBe(false);
    expect(isValidToolName({})).toBe(false);
  });
});

describe('getToolCallDescription', () => {
  it('returns non-empty string for each known tool', () => {
    for (const tool of AI_TOOLS) {
      const desc = getToolCallDescription(tool.function.name, {});
      expect(desc).toBeTruthy();
      expect(typeof desc).toBe('string');
    }
  });

  it('interpolates name in deploy_app', () => {
    const desc = getToolCallDescription('deploy_app', { app_name: 'my-app', size: 'small' });
    expect(desc).toContain('my-app');
    expect(desc).toContain('small');
  });

  it('shows image name in deploy_app when no app_name', () => {
    const desc = getToolCallDescription('deploy_app', { image: 'redis:8.4' });
    expect(desc).toContain('redis:8.4');
    expect(desc).toContain('Deploying');
  });

  it('prefers app_name over image in deploy_app description', () => {
    const desc = getToolCallDescription('deploy_app', { app_name: 'my-redis', image: 'redis:8.4' });
    expect(desc).toContain('my-redis');
    expect(desc).not.toContain('redis:8.4');
  });

  it('interpolates name in stop_app', () => {
    const desc = getToolCallDescription('stop_app', { app_name: 'my-app' });
    expect(desc).toContain('my-app');
  });

  it('returns "Stopping all apps..." for stop_app with all', () => {
    const desc = getToolCallDescription('stop_app', { app_name: 'all' });
    expect(desc).toBe('Stopping all apps...');
  });

  it('handles comma-separated names in stop_app', () => {
    const desc = getToolCallDescription('stop_app', { app_name: 'redis,postgres' });
    expect(desc).toContain('redis,postgres');
    expect(desc).toContain('Stopping apps');
  });

  it('interpolates amount in fund_credits', () => {
    const desc = getToolCallDescription('fund_credits', { amount: 50 });
    expect(desc).toContain('50');
  });

  it('interpolates state in list_apps', () => {
    const desc = getToolCallDescription('list_apps', { state: 'stopped' });
    expect(desc).toContain('stopped');
  });

  it('interpolates name in app_status', () => {
    const desc = getToolCallDescription('app_status', { app_name: 'my-app' });
    expect(desc).toContain('my-app');
  });

  it('interpolates state in lease_history', () => {
    const desc = getToolCallDescription('lease_history', { state: 'closed' });
    expect(desc).toContain('closed');
  });

  it('returns default description for lease_history without state', () => {
    const desc = getToolCallDescription('lease_history', {});
    expect(desc).toContain('lease history');
  });

  it('returns fallback for unknown tool names', () => {
    const desc = getToolCallDescription('unknown_tool', {});
    expect(desc).toContain('unknown_tool');
  });
});

describe('AI_TOOLS', () => {
  it('includes lease_history tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('lease_history');
  });

  it('includes get_logs tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('get_logs');
  });

  it('has 17 tools total', () => {
    expect(AI_TOOLS).toHaveLength(17);
  });

  it('includes set_custom_domain tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('set_custom_domain');
  });

  it('includes request_faucet tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('request_faucet');
  });

  it('includes restart_app tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('restart_app');
  });

  it('includes update_app tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('update_app');
  });

  it('includes app_diagnostics tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('app_diagnostics');
  });

  it('includes app_releases tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('app_releases');
  });
});

describe('getToolCallDescription - get_logs', () => {
  it('interpolates name in get_logs', () => {
    const desc = getToolCallDescription('get_logs', { app_name: 'my-app' });
    expect(desc).toContain('my-app');
  });
});

describe('getToolCallDescription - new tools', () => {
  it('interpolates name in restart_app', () => {
    const desc = getToolCallDescription('restart_app', { app_name: 'my-api' });
    expect(desc).toContain('my-api');
    expect(desc).toContain('Restarting');
  });

  it('returns "Restarting all apps..." for restart_app with all', () => {
    const desc = getToolCallDescription('restart_app', { app_name: 'all' });
    expect(desc).toBe('Restarting all apps...');
  });

  it('handles comma-separated names in restart_app', () => {
    const desc = getToolCallDescription('restart_app', { app_name: 'redis,postgres' });
    expect(desc).toContain('redis,postgres');
    expect(desc).toContain('Restarting apps');
  });

  it('interpolates name in update_app', () => {
    const desc = getToolCallDescription('update_app', { app_name: 'my-api' });
    expect(desc).toContain('my-api');
    expect(desc).toContain('Updating');
  });

  it('interpolates name in app_diagnostics', () => {
    const desc = getToolCallDescription('app_diagnostics', { app_name: 'my-api' });
    expect(desc).toContain('my-api');
    expect(desc).toContain('diagnostics');
  });

  it('interpolates name in app_releases', () => {
    const desc = getToolCallDescription('app_releases', { app_name: 'my-api' });
    expect(desc).toContain('my-api');
    expect(desc).toContain('releases');
  });

  it('returns description for request_faucet', () => {
    const desc = getToolCallDescription('request_faucet', {});
    expect(desc).toContain('faucet');
  });
});

describe('buildAITools', () => {
  it('returns 17 tools', () => {
    expect(buildAITools(SAMPLE_TIERS)).toHaveLength(17);
  });

  it('renders deploy_app.size.enum from tier list', () => {
    const tools = buildAITools(SAMPLE_TIERS);
    const deploy = tools.find((t) => t.function.name === 'deploy_app');
    const sizeProp = deploy!.function.parameters.properties.size as { enum?: string[] };
    expect(sizeProp.enum).toEqual(['docker-micro', 'docker-small']);
  });

  it('omits size.enum when tier list is empty (executor handles rejection)', () => {
    const tools = buildAITools([]);
    const deploy = tools.find((t) => t.function.name === 'deploy_app');
    const sizeProp = deploy!.function.parameters.properties.size as { enum?: string[] };
    expect(sizeProp.enum).toBeUndefined();
  });

  it('keeps non-deploy tools unchanged regardless of tiers', () => {
    const a = buildAITools(SAMPLE_TIERS);
    const b = buildAITools([]);
    const stopA = JSON.stringify(a.find((t) => t.function.name === 'stop_app'));
    const stopB = JSON.stringify(b.find((t) => t.function.name === 'stop_app'));
    expect(stopA).toBe(stopB);
  });
});

describe("getDisplaySafeArgs", () => {
  it("returns only public schema keys for deploy_app", () => {
    const out = getDisplaySafeArgs("deploy_app", {
      app_name: "redis",
      image: "redis:8",
      // internal-only keys that should be dropped:
      skuUuid: "sku-1",
      providerUuid: "p-1",
      providerUrl: "https://fred.example.com",
      _generatedManifest: "{...}",
      customDomainServiceName: "",
      customDomainWarning: "",
    });
    expect(out).toEqual({ app_name: "redis", image: "redis:8" });
  });

  it("returns only public schema keys for set_custom_domain", () => {
    const out = getDisplaySafeArgs("set_custom_domain", {
      app_name: "redis",
      custom_domain: "redis.example.com",
      service_name: "",
      // internal:
      leaseUuid: "lease-1",
      currentDomain: "",
      expectedCnameTarget: "auto.barney0.manifest0.net",
      warning: "",
      address: "manifest1abc",
    });
    expect(Object.keys(out).sort()).toEqual(["app_name", "custom_domain", "service_name"].sort());
  });

  it("drops undefined values", () => {
    const out = getDisplaySafeArgs("deploy_app", { app_name: "x", image: undefined });
    expect(out).toEqual({ app_name: "x" });
  });

  it("returns {} for unknown tool names (UI-internal like batch_deploy)", () => {
    const out = getDisplaySafeArgs("batch_deploy", { entries: [] });
    expect(out).toEqual({});
  });
});
