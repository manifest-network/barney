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
    expect(prompt).toContain('micro');
    expect(prompt).toContain('small');
    expect(prompt).toContain('medium');
    expect(prompt).toContain('large');
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
    expect(prompt).toContain('On file attachment');
    expect(prompt).toContain('Deploy by image');
    expect(prompt).toContain('Default size');
    expect(prompt).toContain('Be concise');
  });

  it('contains file attachment instructions', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('(File attached:');
    expect(prompt).toContain('call deploy_app()');
  });

  it('contains image-based deploy instructions', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('deploy_app(image=');
    expect(prompt).toContain('image="postgres:17"');
  });

  it('instructs to ask user for unlisted images', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('ask the user for port and env before deploying');
  });

  it('contains Known Images section', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('## Known Images');
    expect(prompt).toContain('postgres: port=5432');
    expect(prompt).toContain('neo4j: port=7474,7687');
    expect(prompt).toContain('redis: port=6379');
    expect(prompt).toContain('nginx: port=80');
    expect(prompt).toContain('POSTGRES_PASSWORD=""');
  });

  it('contains storage instructions for stateful apps', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('storage=true');
  });

  it('contains Compose Features section', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('## Compose Features');
    expect(prompt).toContain('health_check');
    expect(prompt).toContain('depends_on');
    expect(prompt).toContain('stop_grace_period');
    expect(prompt).toContain('init');
    expect(prompt).toContain('expose');
    expect(prompt).toContain('labels');
  });

  it('includes health_check indicator in Known Images section', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('health_check=yes');
  });

  it('contains Service Stacks section', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('## Service Stacks');
    expect(prompt).toContain('wordpress');
    expect(prompt).toContain('ghost');
  });

  it('contains stack deploy example with depends_on', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('depends_on');
    expect(prompt).toContain('service_healthy');
  });
});
