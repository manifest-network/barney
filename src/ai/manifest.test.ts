import { describe, it, expect } from 'vitest';
import { deriveAppNameFromImage, normalizePorts, buildManifest } from './manifest';

describe('deriveAppNameFromImage', () => {
  it('extracts name from simple image:tag', () => {
    expect(deriveAppNameFromImage('redis:8.4')).toBe('redis');
  });

  it('extracts name from image without tag', () => {
    expect(deriveAppNameFromImage('postgres')).toBe('postgres');
  });

  it('strips registry prefix', () => {
    expect(deriveAppNameFromImage('docker.io/library/redis:8.4')).toBe('redis');
  });

  it('strips ghcr.io registry prefix', () => {
    expect(deriveAppNameFromImage('ghcr.io/org/my-app:latest')).toBe('my-app');
  });

  it('strips digest suffix', () => {
    expect(deriveAppNameFromImage('postgres@sha256:abcdef1234567890')).toBe('postgres');
  });

  it('handles multi-level path', () => {
    expect(deriveAppNameFromImage('registry.example.com/org/sub/my-image:v1')).toBe('my-image');
  });

  it('normalizes special characters', () => {
    expect(deriveAppNameFromImage('my_app.v2:latest')).toBe('my-app-v2');
  });

  it('collapses consecutive hyphens', () => {
    expect(deriveAppNameFromImage('my___app:latest')).toBe('my-app');
  });

  it('truncates to 32 characters', () => {
    const longName = 'a'.repeat(50);
    expect(deriveAppNameFromImage(longName).length).toBeLessThanOrEqual(32);
  });

  it('returns "app" for empty result', () => {
    expect(deriveAppNameFromImage('...:latest')).toBe('app');
  });

  it('handles :latest tag', () => {
    expect(deriveAppNameFromImage('nginx:latest')).toBe('nginx');
  });
});

describe('normalizePorts', () => {
  it('adds /tcp suffix to bare port', () => {
    expect(normalizePorts('6379')).toEqual({ '6379/tcp': {} });
  });

  it('handles multiple comma-separated ports', () => {
    expect(normalizePorts('6379,8080')).toEqual({
      '6379/tcp': {},
      '8080/tcp': {},
    });
  });

  it('preserves explicit protocol suffix', () => {
    expect(normalizePorts('53/udp')).toEqual({ '53/udp': {} });
  });

  it('handles mixed protocols', () => {
    expect(normalizePorts('8080/tcp,53/udp')).toEqual({
      '8080/tcp': {},
      '53/udp': {},
    });
  });

  it('handles whitespace around ports', () => {
    expect(normalizePorts(' 6379 , 8080 ')).toEqual({
      '6379/tcp': {},
      '8080/tcp': {},
    });
  });

  it('returns empty object for empty string', () => {
    expect(normalizePorts('')).toEqual({});
  });
});

describe('buildManifest', () => {
  it('builds minimal manifest with image only', async () => {
    const result = await buildManifest({ image: 'redis:8.4' });
    const parsed = JSON.parse(result.json);

    expect(parsed.image).toBe('redis:8.4');
    expect(result.derivedAppName).toBe('redis');
    expect(result.payload.hash).toHaveLength(64);
    expect(result.payload.bytes).toBeInstanceOf(Uint8Array);
    expect(result.payload.size).toBeGreaterThan(0);
    expect(result.payload.filename).toBe('redis.json');
  });

  it('includes ports when specified', async () => {
    const result = await buildManifest({ image: 'redis:8.4', port: '6379' });
    const parsed = JSON.parse(result.json);

    expect(parsed.ports).toEqual({ '6379/tcp': {} });
  });

  it('auto-generates passwords for empty env values', async () => {
    const result = await buildManifest({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: '', POSTGRES_DB: 'mydb' },
    });
    const parsed = JSON.parse(result.json);

    expect(parsed.env.POSTGRES_PASSWORD).toHaveLength(16);
    expect(parsed.env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]+$/);
    expect(parsed.env.POSTGRES_DB).toBe('mydb');
  });

  it('preserves non-empty env values', async () => {
    const result = await buildManifest({
      image: 'redis:8.4',
      env: { REDIS_MAX_MEMORY: '256mb' },
    });
    const parsed = JSON.parse(result.json);

    expect(parsed.env.REDIS_MAX_MEMORY).toBe('256mb');
  });

  it('includes user when specified', async () => {
    const result = await buildManifest({ image: 'postgres:18', user: '999:999' });
    const parsed = JSON.parse(result.json);

    expect(parsed.user).toBe('999:999');
  });

  it('includes tmpfs when specified', async () => {
    const result = await buildManifest({ image: 'postgres:18', tmpfs: '/var/run/postgresql' });
    const parsed = JSON.parse(result.json);

    expect(parsed.tmpfs).toEqual(['/var/run/postgresql']);
  });

  it('handles multiple tmpfs paths', async () => {
    const result = await buildManifest({ image: 'nginx:latest', tmpfs: '/var/cache/nginx,/var/run' });
    const parsed = JSON.parse(result.json);

    expect(parsed.tmpfs).toEqual(['/var/cache/nginx', '/var/run']);
  });

  it('computes correct hash', async () => {
    const result = await buildManifest({ image: 'redis:8.4' });

    // Hash should be consistent for same input
    const result2 = await buildManifest({ image: 'redis:8.4' });
    expect(result.payload.hash).toBe(result2.payload.hash);
  });

  it('omits env when empty object', async () => {
    const result = await buildManifest({ image: 'redis:8.4', env: {} });
    const parsed = JSON.parse(result.json);

    expect(parsed.env).toBeUndefined();
  });

  it('builds full manifest matching example app format', async () => {
    const result = await buildManifest({
      image: 'postgres:18',
      port: '5432',
      env: { POSTGRES_PASSWORD: '' },
      user: '999:999',
      tmpfs: '/var/run/postgresql',
    });
    const parsed = JSON.parse(result.json);

    expect(parsed.image).toBe('postgres:18');
    expect(parsed.ports).toEqual({ '5432/tcp': {} });
    expect(parsed.env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(parsed.user).toBe('999:999');
    expect(parsed.tmpfs).toEqual(['/var/run/postgresql']);
    expect(result.derivedAppName).toBe('postgres');
  });
});
