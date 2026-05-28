import { describe, it, expect } from 'vitest';
import { getSystemPrompt } from './systemPrompt';
import type { ResolvedSkuTier } from '../api/skuTiers';

const SAMPLE_TIERS: ResolvedSkuTier[] = [
  { skuName: 'docker-micro', skuUuid: 'a', providerUuid: 'p', cores: 0.5, ramMB: 512, diskGB: 1, pricePerHour: 0.036, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-small', skuUuid: 'b', providerUuid: 'p', cores: 1, ramMB: 1024, diskGB: 5, pricePerHour: 0.1, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-medium', skuUuid: 'c', providerUuid: 'p', cores: 2, ramMB: 2048, diskGB: 10, pricePerHour: 0.2, denomSymbol: 'PWR', unit: 1 },
  { skuName: 'docker-large', skuUuid: 'd', providerUuid: 'p', cores: 4, ramMB: 4096, diskGB: 20, pricePerHour: 0.5, denomSymbol: 'PWR', unit: 1 },
];

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
    expect(prompt).toContain('app_status');
    expect(prompt).toContain('get_balance');
    expect(prompt).toContain('browse_catalog');
    expect(prompt).toContain('cosmos_query');
    expect(prompt).toContain('cosmos_tx');
    expect(prompt).toContain('update_app');
    expect(prompt).toContain('restart_app');
    expect(prompt).toContain('app_diagnostics');
    expect(prompt).toContain('request_faucet');
  });

  it('contains resource tiers when supplied', () => {
    const prompt = getSystemPrompt(undefined, SAMPLE_TIERS);
    expect(prompt).toContain('docker-micro');
    expect(prompt).toContain('docker-small');
    expect(prompt).toContain('docker-medium');
    expect(prompt).toContain('docker-large');
  });

  it('renders specs and per-hour price per tier', () => {
    const prompt = getSystemPrompt(undefined, SAMPLE_TIERS);
    expect(prompt).toMatch(/docker-micro.*0\.5 cores.*512 MB.*1 GB/);
    expect(prompt).toMatch(/0\.0360.*PWR\/hr/);
  });

  it('renders only tiers from the resolved list (no extras)', () => {
    const onlyMicroLarge: ResolvedSkuTier[] = [SAMPLE_TIERS[0], SAMPLE_TIERS[3]];
    const prompt = getSystemPrompt(undefined, onlyMicroLarge);
    expect(prompt).toContain('docker-micro');
    expect(prompt).toContain('docker-large');
    expect(prompt).not.toContain('docker-small');
    expect(prompt).not.toContain('docker-medium');
  });

  it('falls back to a loading notice when tier list is empty', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Resource Tiers');
    expect(prompt).toMatch(/tier catalog/i);
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
    expect(prompt).toContain('Deploy by name');
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

  it('contains Compose features including depends_on and service_healthy', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('depends_on');
    expect(prompt).toContain('service_healthy');
  });

  it('contains Demo Games section with game tags and port 8080', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('## Demo Games');
    expect(prompt).toContain('tetris');
    expect(prompt).toContain('doom');
    expect(prompt).toContain('port="8080"');
  });

  it('examples reference rule 5 for fallback message', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('message from rule 5');
    expect(prompt).not.toContain('message from rule 3');
  });

  it('contains demo game deploy examples', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Deploy tetris');
    expect(prompt).toContain('demo-games:tetris');
    expect(prompt).toContain('play doom');
    expect(prompt).toContain('demo-games:doom');
  });

  it('contains multi-call examples for deploy and stop', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Deploy tetris, doom and hextris');
    expect(prompt).toContain('deploy_app once for EACH');
    expect(prompt).toContain('Stop redis and postgres');
    expect(prompt).toContain('stop_app(app_name="redis,postgres")');
  });

  it('contains restart all and comma-separated rules', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('restart_app(app_name="all")');
    expect(prompt).toContain('comma-separated');
  });

  it('contains combined-action example', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('stop my-app and show games');
    expect(prompt).toContain('example apps below');
  });

  it('rule 4 generalizes multiple names to multiple tool calls', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('Multiple names = multiple calls');
    expect(prompt).toContain('deploy, status');
  });

  it('rule 4 excludes stop and restart (handled by rule 9 comma-separated)', () => {
    const prompt = getSystemPrompt();
    // Rule 4 should direct stop/restart to rule 9 instead of multiple calls
    expect(prompt).toContain('For stop and restart, use comma-separated');
  });

  it('rule 5 prioritizes checking names before fallback message', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain('FIRST check if the user names any app');
    expect(prompt).toContain('ONLY if the user gives a completely generic deploy request');
  });
});
