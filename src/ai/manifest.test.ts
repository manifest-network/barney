import { describe, it, expect } from 'vitest';
import { deriveAppNameFromImage, normalizePorts, buildManifest, mergeManifest } from './manifest';

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

describe('mergeManifest', () => {
  it('carries forward old env vars when new manifest has no env', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({ image: 'postgres:18', env: { POSTGRES_PASSWORD: 'secret123' } });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.image).toBe('postgres:19');
    expect(merged.env).toEqual({ POSTGRES_PASSWORD: 'secret123' });
  });

  it('new env vars override old ones', () => {
    const newManifest = { image: 'postgres:19', env: { POSTGRES_PASSWORD: 'newpass', POSTGRES_DB: 'newdb' } };
    const oldJson = JSON.stringify({ image: 'postgres:18', env: { POSTGRES_PASSWORD: 'oldpass', POSTGRES_USER: 'admin' } });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.env).toEqual({ POSTGRES_PASSWORD: 'newpass', POSTGRES_USER: 'admin', POSTGRES_DB: 'newdb' });
  });

  it('carries forward old ports when new manifest has no ports', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({ image: 'postgres:18', ports: { '5432/tcp': {} } });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.ports).toEqual({ '5432/tcp': {} });
  });

  it('new ports override old ones', () => {
    const newManifest = { image: 'nginx:latest', ports: { '8080/tcp': {} } };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', ports: { '80/tcp': {} } });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.ports).toEqual({ '80/tcp': {}, '8080/tcp': {} });
  });

  it('carries forward old user when new manifest omits it', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({ image: 'postgres:18', user: '999:999' });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.user).toBe('999:999');
  });

  it('new user takes precedence over old user', () => {
    const newManifest = { image: 'postgres:19', user: '1000:1000' };
    const oldJson = JSON.stringify({ image: 'postgres:18', user: '999:999' });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.user).toBe('1000:1000');
  });

  it('carries forward old tmpfs when new manifest omits it', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({ image: 'postgres:18', tmpfs: ['/var/run/postgresql'] });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.tmpfs).toEqual(['/var/run/postgresql']);
  });

  it('new tmpfs takes precedence over old tmpfs', () => {
    const newManifest = { image: 'postgres:19', tmpfs: ['/tmp'] };
    const oldJson = JSON.stringify({ image: 'postgres:18', tmpfs: ['/var/run/postgresql'] });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.tmpfs).toEqual(['/tmp']);
  });

  it('always uses image from new manifest', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({ image: 'postgres:18' });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.image).toBe('postgres:19');
  });

  it('returns new manifest unchanged when old manifest JSON is invalid', () => {
    const newManifest = { image: 'redis:8', env: { KEY: 'val' } };

    const merged = mergeManifest(newManifest, 'not valid json');

    expect(merged).toEqual(newManifest);
  });

  it('returns new manifest unchanged when old manifest is not an object', () => {
    const newManifest = { image: 'redis:8' };

    expect(mergeManifest(newManifest, '"string"')).toEqual(newManifest);
    expect(mergeManifest(newManifest, '[]')).toEqual(newManifest);
    expect(mergeManifest(newManifest, 'null')).toEqual(newManifest);
  });

  it('skips old env when it is an array instead of an object', () => {
    const newManifest = { image: 'redis:8' };
    const oldJson = JSON.stringify({ image: 'redis:7', env: ['FOO=bar'] });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.env).toBeUndefined();
  });

  it('skips old ports when it is an array instead of an object', () => {
    const newManifest = { image: 'redis:8' };
    const oldJson = JSON.stringify({ image: 'redis:7', ports: ['80/tcp'] });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.ports).toBeUndefined();
  });

  it('does not carry forward unknown old fields', () => {
    const newManifest = { image: 'redis:8' };
    const oldJson = JSON.stringify({ image: 'redis:7', custom_field: 'value' });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged).toEqual({ image: 'redis:8' });
    expect((merged as Record<string, unknown>).custom_field).toBeUndefined();
  });

  it('merges all fields together in a full scenario', () => {
    const newManifest = { image: 'postgres:19', env: { POSTGRES_DB: 'newdb' } };
    const oldJson = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'secret', POSTGRES_DB: 'olddb' },
      ports: { '5432/tcp': {} },
      user: '999:999',
      tmpfs: ['/var/run/postgresql'],
    });

    const merged = mergeManifest(newManifest, oldJson);

    expect(merged.image).toBe('postgres:19');
    expect(merged.env).toEqual({ POSTGRES_PASSWORD: 'secret', POSTGRES_DB: 'newdb' });
    expect(merged.ports).toEqual({ '5432/tcp': {} });
    expect(merged.user).toBe('999:999');
    expect(merged.tmpfs).toEqual(['/var/run/postgresql']);
  });
});
