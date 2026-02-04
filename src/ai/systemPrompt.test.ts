import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-browser', () => ({
  getAvailableModules: vi.fn(),
  getModuleSubcommands: vi.fn(),
}));

import { getAvailableModules, getModuleSubcommands } from '@manifest-network/manifest-mcp-browser';
import { getSystemPrompt } from './systemPrompt';

const mockGetAvailableModules = vi.mocked(getAvailableModules);
const mockGetModuleSubcommands = vi.mocked(getModuleSubcommands);

describe('getSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the cached doc between tests by re-importing
    vi.resetModules();

    mockGetAvailableModules.mockReturnValue({
      queryModules: [{ name: 'bank', description: 'Bank module' }],
      txModules: [{ name: 'billing', description: 'Billing module' }],
    } as any);

    mockGetModuleSubcommands.mockReturnValue([
      { name: 'balances', description: 'Query balances', args: '["address"]' },
    ] as any);
  });

  it('contains AI assistant identity', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh('manifest1abc');
    expect(prompt).toContain('Barney');
  });

  it('contains tool documentation sections', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    expect(prompt).toContain('get_balance');
    expect(prompt).toContain('get_leases');
    expect(prompt).toContain('create_lease');
    expect(prompt).toContain('cosmos_query');
  });

  it('contains cosmos operations documentation from modules', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    expect(prompt).toContain('Query Modules');
    expect(prompt).toContain('Transaction Modules');
    expect(prompt).toContain('bank');
    expect(prompt).toContain('billing');
    expect(prompt).toContain('balances');
  });

  it('includes wallet address when provided', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh('manifest1xyz');
    expect(prompt).toContain('manifest1xyz');
    expect(prompt).toContain('Connected wallet address');
  });

  it('shows no-wallet message when address is undefined', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    expect(prompt).toContain('No wallet connected');
  });

  it('caches cosmos operations doc on subsequent calls', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    fresh();
    fresh();
    // getAvailableModules should only be called once due to caching
    expect(mockGetAvailableModules).toHaveBeenCalledTimes(1);
  });

  it('handles getModuleSubcommands throwing gracefully', async () => {
    mockGetModuleSubcommands.mockImplementation(() => {
      throw new Error('not available');
    });

    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    // Should still contain the module names even if subcommands fail
    expect(prompt).toContain('bank');
    expect(prompt).toContain('billing');
  });

  it('contains token denomination info', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    expect(prompt).toContain('umfx');
    expect(prompt).toContain('MFX');
  });

  it('contains lease state documentation', async () => {
    const { getSystemPrompt: fresh } = await import('./systemPrompt');
    const prompt = fresh();
    expect(prompt).toContain('PENDING');
    expect(prompt).toContain('ACTIVE');
    expect(prompt).toContain('CLOSED');
  });
});
