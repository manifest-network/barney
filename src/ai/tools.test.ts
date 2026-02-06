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
});
