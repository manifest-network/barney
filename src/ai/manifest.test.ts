import { describe, it, expect } from 'vitest';
import {
  deriveAppNameFromImage,
  normalizePorts,
  buildManifest,
  mergeManifest,
  buildStackManifest,
  isStackManifest,
  parseStackManifest,
  validateServiceName,
  getServiceNames,
} from './manifest';

describe('deriveAppNameFromImage', () => {
  it('includes tag in derived name', () => {
    expect(deriveAppNameFromImage('redis:8.4')).toBe('redis-8-4');
  });

  it('extracts name from image without tag', () => {
    expect(deriveAppNameFromImage('postgres')).toBe('postgres');
  });

  it('strips registry prefix and includes tag', () => {
    expect(deriveAppNameFromImage('docker.io/library/redis:8.4')).toBe('redis-8-4');
  });

  it('strips ghcr.io registry prefix and excludes latest tag', () => {
    expect(deriveAppNameFromImage('ghcr.io/org/my-app:latest')).toBe('my-app');
  });

  it('strips digest suffix', () => {
    expect(deriveAppNameFromImage('postgres@sha256:abcdef1234567890')).toBe('postgres');
  });

  it('handles multi-level path with tag', () => {
    expect(deriveAppNameFromImage('registry.example.com/org/sub/my-image:v1')).toBe('my-image-v1');
  });

  it('normalizes special characters and excludes latest', () => {
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

  it('excludes latest tag from name', () => {
    expect(deriveAppNameFromImage('nginx:latest')).toBe('nginx');
  });

  it('includes semver-style tags', () => {
    expect(deriveAppNameFromImage('postgres:16.2')).toBe('postgres-16-2');
  });

  it('includes alpine variant tags', () => {
    expect(deriveAppNameFromImage('node:20-alpine')).toBe('node-20-alpine');
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
    expect(result.derivedAppName).toBe('redis-8-4');
    expect(result.payload.hash).toHaveLength(64);
    expect(result.payload.bytes).toBeInstanceOf(Uint8Array);
    expect(result.payload.size).toBeGreaterThan(0);
    expect(result.payload.filename).toBe('redis-8-4.json');
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

  it('appends generated password to env values ending with "/"', async () => {
    const result = await buildManifest({
      image: 'neo4j:latest',
      env: { NEO4J_AUTH: 'neo4j/' },
    });
    const parsed = JSON.parse(result.json);

    expect(parsed.env.NEO4J_AUTH).toMatch(/^neo4j\/[A-Za-z0-9]{16}$/);
    expect(parsed.env.NEO4J_AUTH.length).toBe(5 + 1 + 16); // "neo4j" + "/" + 16-char password
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

  it('includes health_check when specified', async () => {
    const result = await buildManifest({
      image: 'postgres:18',
      health_check: { test: ['CMD-SHELL', 'pg_isready'], interval: '10s', timeout: '5s', retries: 3, start_period: '30s' },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.health_check).toEqual({
      test: ['CMD-SHELL', 'pg_isready'],
      interval: '10s',
      timeout: '5s',
      retries: 3,
      start_period: '30s',
    });
  });

  it('includes stop_grace_period when specified', async () => {
    const result = await buildManifest({ image: 'nginx', stop_grace_period: '30s' });
    const parsed = JSON.parse(result.json);
    expect(parsed.stop_grace_period).toBe('30s');
  });

  it('includes init when specified', async () => {
    const result = await buildManifest({ image: 'nginx', init: true });
    const parsed = JSON.parse(result.json);
    expect(parsed.init).toBe(true);
  });

  it('includes expose as array when specified', async () => {
    const result = await buildManifest({ image: 'nginx', expose: '3000,9090' });
    const parsed = JSON.parse(result.json);
    expect(parsed.expose).toEqual(['3000', '9090']);
  });

  it('includes labels when specified', async () => {
    const result = await buildManifest({ image: 'nginx', labels: { app: 'myapp', tier: 'frontend' } });
    const parsed = JSON.parse(result.json);
    expect(parsed.labels).toEqual({ app: 'myapp', tier: 'frontend' });
  });

  it('includes init: false when explicitly set', async () => {
    const result = await buildManifest({ image: 'nginx', init: false });
    const parsed = JSON.parse(result.json);
    expect(parsed.init).toBe(false);
  });

  it('omits init when undefined', async () => {
    const result = await buildManifest({ image: 'nginx' });
    const parsed = JSON.parse(result.json);
    expect(parsed.init).toBeUndefined();
  });

  it('omits expose when empty string', async () => {
    const result = await buildManifest({ image: 'nginx', expose: '' });
    const parsed = JSON.parse(result.json);
    expect(parsed.expose).toBeUndefined();
  });

  it('handles expose with whitespace around values', async () => {
    const result = await buildManifest({ image: 'nginx', expose: ' 3000 , 9090 ' });
    const parsed = JSON.parse(result.json);
    expect(parsed.expose).toEqual(['3000', '9090']);
  });

  it('handles single port in expose', async () => {
    const result = await buildManifest({ image: 'nginx', expose: '3000' });
    const parsed = JSON.parse(result.json);
    expect(parsed.expose).toEqual(['3000']);
  });

  it('omits labels when empty object', async () => {
    const result = await buildManifest({ image: 'nginx', labels: {} });
    const parsed = JSON.parse(result.json);
    expect(parsed.labels).toBeUndefined();
  });

  it('includes health_check with only required test field', async () => {
    const result = await buildManifest({
      image: 'nginx',
      health_check: { test: ['CMD', 'curl', '-f', 'http://localhost'] },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.health_check).toEqual({ test: ['CMD', 'curl', '-f', 'http://localhost'] });
  });

  it('includes depends_on when specified', async () => {
    const result = await buildManifest({
      image: 'nginx',
      depends_on: { db: { condition: 'service_healthy' } },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('omits depends_on when empty object', async () => {
    const result = await buildManifest({ image: 'nginx', depends_on: {} });
    const parsed = JSON.parse(result.json);
    expect(parsed.depends_on).toBeUndefined();
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
    expect(result.derivedAppName).toBe('postgres-18');
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

  it('carries forward health_check from old manifest', () => {
    const newManifest = { image: 'postgres:19' };
    const oldJson = JSON.stringify({
      image: 'postgres:18',
      health_check: { test: ['CMD-SHELL', 'pg_isready'], interval: '10s' },
    });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.health_check).toEqual({ test: ['CMD-SHELL', 'pg_isready'], interval: '10s' });
  });

  it('new health_check overrides old one', () => {
    const newManifest = {
      image: 'postgres:19',
      health_check: { test: ['CMD', 'pg_isready', '-U', 'admin'] },
    };
    const oldJson = JSON.stringify({
      image: 'postgres:18',
      health_check: { test: ['CMD-SHELL', 'pg_isready'], interval: '10s' },
    });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.health_check).toEqual({ test: ['CMD', 'pg_isready', '-U', 'admin'] });
  });

  it('carries forward stop_grace_period from old manifest', () => {
    const newManifest = { image: 'nginx:latest' };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', stop_grace_period: '30s' });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.stop_grace_period).toBe('30s');
  });

  it('carries forward init from old manifest', () => {
    const newManifest = { image: 'nginx:latest' };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', init: true });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.init).toBe(true);
  });

  it('carries forward expose from old manifest', () => {
    const newManifest = { image: 'nginx:latest' };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', expose: ['3000', '9090'] });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.expose).toEqual(['3000', '9090']);
  });

  it('merges labels like env (old carry forward, new override)', () => {
    const newManifest = { image: 'nginx:latest', labels: { tier: 'premium', version: '2' } };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', labels: { app: 'myapp', tier: 'basic' } });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.labels).toEqual({ app: 'myapp', tier: 'premium', version: '2' });
  });

  it('skips old labels when it is an array instead of an object', () => {
    const newManifest = { image: 'redis:8' };
    const oldJson = JSON.stringify({ image: 'redis:7', labels: ['foo=bar'] });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.labels).toBeUndefined();
  });

  it('carries forward depends_on from old manifest', () => {
    const newManifest = { image: 'nginx:latest' };
    const oldJson = JSON.stringify({ image: 'nginx:1.24', depends_on: { db: { condition: 'service_healthy' } } });
    const merged = mergeManifest(newManifest, oldJson);
    expect(merged.depends_on).toEqual({ db: { condition: 'service_healthy' } });
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

// ============================================================================
// Stack manifest tests
// ============================================================================

describe('validateServiceName', () => {
  it('accepts valid DNS labels', () => {
    expect(validateServiceName('web')).toBeNull();
    expect(validateServiceName('db')).toBeNull();
    expect(validateServiceName('my-service')).toBeNull();
    expect(validateServiceName('a')).toBeNull();
    expect(validateServiceName('a'.repeat(63))).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateServiceName('')).toContain('required');
  });

  it('rejects names over 63 chars', () => {
    expect(validateServiceName('a'.repeat(64))).toContain('63');
  });

  it('rejects uppercase', () => {
    expect(validateServiceName('Web')).toContain('DNS label');
  });

  it('rejects leading hyphen', () => {
    expect(validateServiceName('-web')).toContain('DNS label');
  });

  it('rejects trailing hyphen', () => {
    expect(validateServiceName('web-')).toContain('DNS label');
  });

  it('rejects underscores', () => {
    expect(validateServiceName('my_service')).toContain('DNS label');
  });

  it('rejects dots', () => {
    expect(validateServiceName('my.service')).toContain('DNS label');
  });
});

describe('buildStackManifest', () => {
  it('builds a multi-service manifest', async () => {
    const result = await buildStackManifest({
      services: {
        web: { image: 'nginx:latest', port: '80' },
        db: { image: 'postgres:18', port: '5432', env: { POSTGRES_PASSWORD: 'test' } },
      },
    });

    const parsed = JSON.parse(result.json);
    expect(parsed.services).toBeDefined();
    expect(parsed.services.web.image).toBe('nginx:latest');
    expect(parsed.services.web.ports).toEqual({ '80/tcp': {} });
    expect(parsed.services.db.image).toBe('postgres:18');
    expect(parsed.services.db.env.POSTGRES_PASSWORD).toBe('test');
    expect(result.payload.hash).toHaveLength(64);
    expect(result.payload.filename).toBe('nginx-stack.json');
  });

  it('auto-generates passwords for empty env values', async () => {
    const result = await buildStackManifest({
      services: {
        db: { image: 'postgres:18', env: { POSTGRES_PASSWORD: '' } },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.db.env.POSTGRES_PASSWORD).toHaveLength(16);
    expect(parsed.services.db.env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('throws on empty services', async () => {
    await expect(buildStackManifest({ services: {} })).rejects.toThrow('at least one service');
  });

  it('throws on invalid service name', async () => {
    await expect(
      buildStackManifest({ services: { 'Invalid Name': { image: 'nginx' } } })
    ).rejects.toThrow('Invalid service name');
  });

  it('includes depends_on per service', async () => {
    const result = await buildStackManifest({
      services: {
        web: {
          image: 'nginx',
          port: '80',
          depends_on: { db: { condition: 'service_healthy' } },
        },
        db: {
          image: 'postgres:18',
          port: '5432',
          health_check: { test: ['CMD-SHELL', 'pg_isready'], interval: '10s' },
        },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } });
    expect(parsed.services.db.health_check).toEqual({ test: ['CMD-SHELL', 'pg_isready'], interval: '10s' });
  });

  it('includes init: false per service', async () => {
    const result = await buildStackManifest({
      services: {
        web: { image: 'nginx', init: false },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.web.init).toBe(false);
  });

  it('includes stop_grace_period, expose, and labels per service', async () => {
    const result = await buildStackManifest({
      services: {
        web: {
          image: 'nginx',
          stop_grace_period: '15s',
          expose: '3000',
          labels: { app: 'test' },
        },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.web.stop_grace_period).toBe('15s');
    expect(parsed.services.web.expose).toEqual(['3000']);
    expect(parsed.services.web.labels).toEqual({ app: 'test' });
  });

  it('omits empty labels and expose per service', async () => {
    const result = await buildStackManifest({
      services: {
        web: { image: 'nginx', labels: {}, expose: '' },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.web.labels).toBeUndefined();
    expect(parsed.services.web.expose).toBeUndefined();
  });

  it('includes user and tmpfs per service', async () => {
    const result = await buildStackManifest({
      services: {
        db: { image: 'postgres:18', user: '999:999', tmpfs: '/var/run/postgresql' },
      },
    });
    const parsed = JSON.parse(result.json);
    expect(parsed.services.db.user).toBe('999:999');
    expect(parsed.services.db.tmpfs).toEqual(['/var/run/postgresql']);
  });
});

describe('isStackManifest', () => {
  it('returns true for stack manifest', () => {
    expect(isStackManifest({ services: { web: { image: 'nginx' } } })).toBe(true);
  });

  it('returns false for single-service manifest', () => {
    expect(isStackManifest({ image: 'nginx', ports: {} })).toBe(false);
  });

  it('returns false for empty services', () => {
    expect(isStackManifest({ services: {} })).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isStackManifest(null)).toBe(false);
    expect(isStackManifest('string')).toBe(false);
    expect(isStackManifest(42)).toBe(false);
  });

  it('returns false for array services', () => {
    expect(isStackManifest({ services: ['web'] })).toBe(false);
  });
});

describe('parseStackManifest', () => {
  it('parses valid stack JSON', () => {
    const json = JSON.stringify({ services: { web: { image: 'nginx' }, db: { image: 'postgres' } } });
    const result = parseStackManifest(json);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.services)).toEqual(['web', 'db']);
  });

  it('returns null for single-service JSON', () => {
    expect(parseStackManifest(JSON.stringify({ image: 'nginx' }))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStackManifest('not json')).toBeNull();
  });
});

describe('getServiceNames', () => {
  it('returns service names from stack manifest', () => {
    expect(getServiceNames({ services: { web: {}, db: {} } })).toEqual(['web', 'db']);
  });

  it('returns empty array for single-service manifest', () => {
    expect(getServiceNames({ image: 'nginx' })).toEqual([]);
  });

  it('returns empty array for non-object', () => {
    expect(getServiceNames(null)).toEqual([]);
  });
});
