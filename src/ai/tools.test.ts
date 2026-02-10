import { describe, it, expect } from 'vitest';
import {
  requiresConfirmation,
  isValidToolName,
  getToolCallDescription,
  AI_TOOLS,
  CONFIRMATION_TOOLS,
} from './tools';

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

  it('has 15 tools total', () => {
    expect(AI_TOOLS).toHaveLength(15);
  });

  it('includes restart_app tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('restart_app');
  });

  it('includes update_app tool', () => {
    const toolNames = AI_TOOLS.map((t) => t.function.name);
    expect(toolNames).toContain('update_app');
  });

  it('includes storage param in deploy_app', () => {
    const deployTool = AI_TOOLS.find((t) => t.function.name === 'deploy_app');
    expect(deployTool?.function.parameters.properties).toHaveProperty('storage');
    expect(deployTool?.function.parameters.properties.storage.type).toBe('boolean');
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
});
