import { describe, it, expect } from 'vitest';
import { findKnownImage, findKnownStack, generateImageReferenceForPrompt, generateStackReferenceForPrompt, KNOWN_IMAGES, KNOWN_STACKS } from './knownImages';

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

describe('known image health checks', () => {
  const imagesWithHealthChecks = KNOWN_IMAGES.filter(cfg => cfg.health_check);

  it('has health checks for key database images', () => {
    const names = imagesWithHealthChecks.map(cfg => cfg.image);
    expect(names).toContain('postgres');
    expect(names).toContain('mysql');
    expect(names).toContain('mariadb');
    expect(names).toContain('redis');
  });

  it('health checks have valid test arrays', () => {
    for (const cfg of imagesWithHealthChecks) {
      expect(cfg.health_check!.test).toBeInstanceOf(Array);
      expect(cfg.health_check!.test.length).toBeGreaterThanOrEqual(2);
      expect(['CMD', 'CMD-SHELL']).toContain(cfg.health_check!.test[0]);
    }
  });
});

describe('known stack depends_on', () => {
  it('wordpress web depends on db with service_healthy', () => {
    const wp = KNOWN_STACKS.find(s => s.name === 'wordpress')!;
    expect(wp.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('ghost web depends on db with service_healthy', () => {
    const ghost = KNOWN_STACKS.find(s => s.name === 'ghost')!;
    expect(ghost.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('adminer-postgres adminer depends on db with service_healthy', () => {
    const ap = KNOWN_STACKS.find(s => s.name === 'adminer-postgres')!;
    expect(ap.services.adminer.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('depends_on conditions are valid', () => {
    const validConditions = new Set(['service_started', 'service_healthy', 'service_completed_successfully']);
    for (const stack of KNOWN_STACKS) {
      for (const [, svc] of Object.entries(stack.services)) {
        if (svc.depends_on) {
          for (const dep of Object.values(svc.depends_on)) {
            expect(validConditions).toContain(dep.condition);
          }
        }
      }
    }
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

  it('includes health_check indicator for images with health checks', () => {
    const ref = generateImageReferenceForPrompt();
    const postgresLine = ref.split('\n').find(l => l.startsWith('postgres:'));
    expect(postgresLine).toContain('health_check=yes');
    const redisLine = ref.split('\n').find(l => l.startsWith('redis:'));
    expect(redisLine).toContain('health_check=yes');
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

describe('findKnownStack', () => {
  it('matches exact stack name', () => {
    const stack = findKnownStack('wordpress');
    expect(stack).toBeDefined();
    expect(stack!.name).toBe('wordpress');
    expect(Object.keys(stack!.services)).toContain('web');
    expect(Object.keys(stack!.services)).toContain('db');
  });

  it('matches by alias', () => {
    const stack = findKnownStack('wp');
    expect(stack).toBeDefined();
    expect(stack!.name).toBe('wordpress');
  });

  it('is case-insensitive', () => {
    const stack = findKnownStack('WordPress');
    expect(stack).toBeDefined();
    expect(stack!.name).toBe('wordpress');
  });

  it('returns undefined for unknown stack', () => {
    expect(findKnownStack('nonexistent')).toBeUndefined();
  });

  it('finds ghost stack', () => {
    const stack = findKnownStack('ghost');
    expect(stack).toBeDefined();
    expect(stack!.services.web.image).toBe('ghost');
    expect(stack!.services.db.image).toBe('mysql');
  });

  it('finds adminer-postgres by alias', () => {
    const stack = findKnownStack('pgadmin');
    expect(stack).toBeDefined();
    expect(stack!.name).toBe('adminer-postgres');
  });
});

describe('generateStackReferenceForPrompt', () => {
  it('includes all known stacks', () => {
    const ref = generateStackReferenceForPrompt();
    for (const stack of KNOWN_STACKS) {
      expect(ref).toContain(stack.name);
    }
  });

  it('includes service names and images', () => {
    const ref = generateStackReferenceForPrompt();
    expect(ref).toContain('web(wordpress)');
    expect(ref).toContain('db(mysql)');
  });

  it('includes aliases', () => {
    const ref = generateStackReferenceForPrompt();
    expect(ref).toContain('(aka wp)');
  });

  it('produces one line per stack', () => {
    const ref = generateStackReferenceForPrompt();
    const lines = ref.split('\n');
    expect(lines.length).toBe(KNOWN_STACKS.length);
  });
});
