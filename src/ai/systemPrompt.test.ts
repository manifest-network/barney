import { describe, it, expect } from 'vitest';
import { getSystemPrompt } from './systemPrompt';

describe('getSystemPrompt', () => {
  it('contains AI assistant identity', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Barney');
    expect(prompt).toContain('deployment assistant');
  });

  it('contains tool names', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('deploy_app');
    expect(prompt).toContain('stop_app');
    expect(prompt).toContain('fund_credits');
    expect(prompt).toContain('list_apps');
    expect(prompt).toContain('app_status');
    expect(prompt).toContain('get_balance');
    expect(prompt).toContain('browse_catalog');
    expect(prompt).toContain('cosmos_query');
    expect(prompt).toContain('cosmos_tx');
  });

  it('contains resource tiers', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('small');
    expect(prompt).toContain('medium');
    expect(prompt).toContain('large');
    expect(prompt).toContain('gpu');
  });

  it('includes wallet address when provided', () => {
    const prompt = getSystemPrompt('manifest1xyz');
    expect(prompt).toContain('manifest1xyz');
    expect(prompt).toContain('Wallet');
  });

  it('shows no-wallet message when address is undefined', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('No wallet connected');
  });

  it('contains vocabulary rules', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Vocabulary');
    expect(prompt).toContain('"apps" not "leases"');
    expect(prompt).toContain('"credits" not "PWR"');
  });

  it('contains behavior rules', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('On file drop');
    expect(prompt).toContain('Default size');
    expect(prompt).toContain('Be concise');
  });
});
