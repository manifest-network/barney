import { describe, it, expect } from 'vitest';
import {
  requiresConfirmation,
  isValidToolName,
  getToolCallDescription,
  AI_TOOLS,
  CONFIRMATION_REQUIRED_TOOLS,
} from './tools';

describe('requiresConfirmation', () => {
  it('returns true for all 5 transaction tools', () => {
    expect(requiresConfirmation('create_lease')).toBe(true);
    expect(requiresConfirmation('close_lease')).toBe(true);
    expect(requiresConfirmation('fund_credit')).toBe(true);
    expect(requiresConfirmation('cosmos_tx')).toBe(true);
    expect(requiresConfirmation('upload_payload')).toBe(true);
  });

  it('returns false for all query tools', () => {
    const queryTools = AI_TOOLS.map((t) => t.function.name).filter(
      (name) => !CONFIRMATION_REQUIRED_TOOLS.has(name)
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
    expect(isValidToolName('Get_Balance')).toBe(false);
    expect(isValidToolName('GET_BALANCE')).toBe(false);
    expect(isValidToolName('Get_Leases')).toBe(false);
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

  it('interpolates state in get_leases', () => {
    const desc = getToolCallDescription('get_leases', { state: 'active' });
    expect(desc).toContain('active');
  });

  it('interpolates provider_uuid in get_skus', () => {
    const uuid = '019beb87-09de-7000-beef-ae733e73ff23';
    const desc = getToolCallDescription('get_skus', { provider_uuid: uuid });
    expect(desc).toContain(uuid);
  });

  it('interpolates amount in fund_credit', () => {
    const desc = getToolCallDescription('fund_credit', { amount: '1000000umfx' });
    expect(desc).toContain('1000000umfx');
  });

  it('interpolates lease_uuid in close_lease', () => {
    const uuid = '019beb87-09de-7000-beef-ae733e73ff23';
    const desc = getToolCallDescription('close_lease', { lease_uuid: uuid });
    expect(desc).toContain(uuid);
  });

  it('handles missing args without crash for get_leases', () => {
    const desc = getToolCallDescription('get_leases', {});
    expect(desc).toBeTruthy();
    expect(desc).not.toContain('undefined');
  });

  it('handles missing args without crash for get_skus', () => {
    const desc = getToolCallDescription('get_skus', {});
    expect(desc).toBeTruthy();
    expect(desc).not.toContain('undefined');
  });

  it('returns fallback for unknown tool names', () => {
    const desc = getToolCallDescription('unknown_tool', {});
    expect(desc).toContain('unknown_tool');
  });
});
