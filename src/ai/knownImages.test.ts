import { describe, it, expect } from 'vitest';
import { findKnownImage, generateImageReferenceForPrompt, KNOWN_IMAGES } from './knownImages';

describe('findKnownImage', () => {
  it('matches exact image name', () => {
    const config = findKnownImage('postgres');
    expect(config).toBeDefined();
    expect(config!.image).toBe('postgres');
    expect(config!.port).toBe('5432');
  });

  it('matches image with tag', () => {
    const config = findKnownImage('postgres:16');
    expect(config).toBeDefined();
    expect(config!.image).toBe('postgres');
  });

  it('matches image with registry prefix', () => {
    const config = findKnownImage('ghcr.io/someorg/redis:8.4');
    expect(config).toBeDefined();
    expect(config!.image).toBe('redis');
  });

  it('matches docker.io/library/ prefix', () => {
    const config = findKnownImage('docker.io/library/nginx:latest');
    expect(config).toBeDefined();
    expect(config!.image).toBe('nginx');
  });

  it('matches by alias', () => {
    const config = findKnownImage('postgresql');
    expect(config).toBeDefined();
    expect(config!.image).toBe('postgres');
  });

  it('matches by alias with tag', () => {
    const config = findKnownImage('mongodb:7');
    expect(config).toBeDefined();
    expect(config!.image).toBe('mongo');
  });

  it('returns undefined for unknown image', () => {
    expect(findKnownImage('my-custom-app:latest')).toBeUndefined();
  });

  it('matches org/image format via alias', () => {
    const config = findKnownImage('clickhouse/clickhouse-server:24');
    expect(config).toBeDefined();
    expect(config!.image).toBe('clickhouse-server');
  });

  it('matches minio/minio format via alias', () => {
    const config = findKnownImage('minio/minio:latest');
    expect(config).toBeDefined();
    expect(config!.image).toBe('minio');
  });

  it('matches grafana/grafana format via alias', () => {
    const config = findKnownImage('grafana/grafana');
    expect(config).toBeDefined();
    expect(config!.image).toBe('grafana');
  });

  it('matches prom/prometheus format via alias', () => {
    const config = findKnownImage('prom/prometheus:v2.50');
    expect(config).toBeDefined();
    expect(config!.image).toBe('prometheus');
  });

  it('matches image with digest', () => {
    const config = findKnownImage('redis@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect(config).toBeDefined();
    expect(config!.image).toBe('redis');
  });

  it('matches valkey alias to redis', () => {
    const config = findKnownImage('valkey:8');
    expect(config).toBeDefined();
    expect(config!.image).toBe('redis');
  });

  it('matches apache alias to httpd', () => {
    const config = findKnownImage('apache');
    expect(config).toBeDefined();
    expect(config!.image).toBe('httpd');
  });

  it('is case-insensitive', () => {
    const config = findKnownImage('POSTGRES:16');
    expect(config).toBeDefined();
    expect(config!.image).toBe('postgres');
  });

  it('matches clickhouse shorthand alias', () => {
    const config = findKnownImage('clickhouse');
    expect(config).toBeDefined();
    expect(config!.image).toBe('clickhouse-server');
  });
});

describe('generateImageReferenceForPrompt', () => {
  it('includes all known images', () => {
    const ref = generateImageReferenceForPrompt();
    for (const cfg of KNOWN_IMAGES) {
      expect(ref).toContain(cfg.image);
    }
  });

  it('includes port for every image', () => {
    const ref = generateImageReferenceForPrompt();
    for (const cfg of KNOWN_IMAGES) {
      expect(ref).toContain(`${cfg.image}: port=${cfg.port}`);
    }
  });

  it('includes env vars when present', () => {
    const ref = generateImageReferenceForPrompt();
    expect(ref).toContain('POSTGRES_PASSWORD=""');
    expect(ref).toContain('NEO4J_AUTH="neo4j/<password>"');
  });

  it('includes storage flag when present', () => {
    const ref = generateImageReferenceForPrompt();
    expect(ref).toContain('postgres: port=5432');
    // postgres line should have storage=true
    const postgresLine = ref.split('\n').find(l => l.startsWith('postgres:'));
    expect(postgresLine).toContain('storage=true');
  });

  it('includes aliases when present', () => {
    const ref = generateImageReferenceForPrompt();
    expect(ref).toContain('(aka postgresql)');
    expect(ref).toContain('(aka mongodb)');
  });

  it('produces one line per image', () => {
    const ref = generateImageReferenceForPrompt();
    const lines = ref.split('\n');
    expect(lines.length).toBe(KNOWN_IMAGES.length);
  });
});
