import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getApps,
  getApp,
  findApp,
  getAppByLease,
  addApp,
  updateApp,
  removeApp,
  reconcileWithChain,
  validateAppName,
  sanitizeManifestForStorage,
  type AppEntry,
} from './appRegistry';

// Mock logError to avoid console noise in tests
vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

const ADDR_A = 'manifest1aaa';
const ADDR_B = 'manifest1bbb';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: '660e8400-e29b-41d4-a716-446655440000',
    providerUrl: 'https://provider.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

describe('appRegistry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --- CRUD ---

  describe('CRUD operations', () => {
    it('returns empty array when no apps exist', () => {
      expect(getApps(ADDR_A)).toEqual([]);
    });

    it('adds and retrieves an app', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      const apps = getApps(ADDR_A);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('my-app');
    });

    it('getApp returns app by name', () => {
      addApp(ADDR_A, makeApp({ name: 'alpha' }));
      addApp(ADDR_A, makeApp({ name: 'beta', leaseUuid: 'uuid-2' }));

      expect(getApp(ADDR_A, 'alpha')?.name).toBe('alpha');
      expect(getApp(ADDR_A, 'beta')?.name).toBe('beta');
      expect(getApp(ADDR_A, 'gamma')).toBeNull();
    });

    it('getAppByLease returns app by lease UUID', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      expect(getAppByLease(ADDR_A, app.leaseUuid)?.name).toBe('my-app');
      expect(getAppByLease(ADDR_A, 'nonexistent')).toBeNull();
    });

    it('updateApp modifies fields', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      const updated = updateApp(ADDR_A, app.leaseUuid, {
        status: 'stopped',
        url: 'https://myapp.example.com',
      });

      expect(updated?.status).toBe('stopped');
      expect(updated?.url).toBe('https://myapp.example.com');

      // Persisted
      const reloaded = getApp(ADDR_A, 'my-app');
      expect(reloaded?.status).toBe('stopped');
    });

    it('updateApp returns null for unknown lease', () => {
      expect(updateApp(ADDR_A, 'nonexistent', { status: 'stopped' })).toBeNull();
    });

    it('removeApp removes an app', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      expect(removeApp(ADDR_A, app.leaseUuid)).toBe(true);
      expect(getApps(ADDR_A)).toHaveLength(0);
    });

    it('removeApp returns false for unknown lease', () => {
      expect(removeApp(ADDR_A, 'nonexistent')).toBe(false);
    });
  });

  // --- Multi-wallet isolation ---

  describe('multi-wallet isolation', () => {
    it('apps are scoped per wallet address', () => {
      addApp(ADDR_A, makeApp({ name: 'app-a' }));
      addApp(ADDR_B, makeApp({ name: 'app-b' }));

      expect(getApps(ADDR_A)).toHaveLength(1);
      expect(getApps(ADDR_A)[0].name).toBe('app-a');

      expect(getApps(ADDR_B)).toHaveLength(1);
      expect(getApps(ADDR_B)[0].name).toBe('app-b');
    });

    it('removing from one wallet does not affect another', () => {
      const app = makeApp();
      addApp(ADDR_A, app);
      addApp(ADDR_B, makeApp({ name: 'other', leaseUuid: 'uuid-other' }));

      removeApp(ADDR_A, app.leaseUuid);
      expect(getApps(ADDR_A)).toHaveLength(0);
      expect(getApps(ADDR_B)).toHaveLength(1);
    });
  });

  // --- Name validation ---

  describe('validateAppName', () => {
    it('accepts valid names', () => {
      expect(validateAppName('my-app', ADDR_A)).toBeNull();
      expect(validateAppName('a', ADDR_A)).toBeNull();
      expect(validateAppName('app123', ADDR_A)).toBeNull();
      expect(validateAppName('a'.repeat(32), ADDR_A)).toBeNull();
    });

    it('rejects empty name', () => {
      expect(validateAppName('', ADDR_A)).toContain('required');
    });

    it('rejects name over 32 chars', () => {
      expect(validateAppName('a'.repeat(33), ADDR_A)).toContain('32');
    });

    it('rejects uppercase', () => {
      expect(validateAppName('MyApp', ADDR_A)).toContain('lowercase');
    });

    it('rejects leading hyphen', () => {
      expect(validateAppName('-app', ADDR_A)).toContain('lowercase');
    });

    it('rejects trailing hyphen', () => {
      expect(validateAppName('app-', ADDR_A)).toContain('lowercase');
    });

    it('rejects special characters', () => {
      expect(validateAppName('my_app', ADDR_A)).toContain('lowercase');
      expect(validateAppName('my.app', ADDR_A)).toContain('lowercase');
      expect(validateAppName('my app', ADDR_A)).toContain('lowercase');
    });

    it('rejects duplicate name within same wallet for running app', () => {
      addApp(ADDR_A, makeApp({ name: 'taken', status: 'running' }));
      expect(validateAppName('taken', ADDR_A)).toContain('is already running');
    });

    it('allows reusing name of stopped app', () => {
      addApp(ADDR_A, makeApp({ name: 'stopped-app', status: 'stopped' }));
      expect(validateAppName('stopped-app', ADDR_A)).toBeNull();
    });

    it('allows reusing name of failed app', () => {
      addApp(ADDR_A, makeApp({ name: 'failed-app', status: 'failed' }));
      expect(validateAppName('failed-app', ADDR_A)).toBeNull();
    });

    it('allows same name in different wallets', () => {
      addApp(ADDR_A, makeApp({ name: 'shared' }));
      expect(validateAppName('shared', ADDR_B)).toBeNull();
    });

    it('allows same name when excludeLeaseUuid matches existing', () => {
      const app = makeApp({ name: 'renamable' });
      addApp(ADDR_A, app);
      expect(validateAppName('renamable', ADDR_A, app.leaseUuid)).toBeNull();
    });
  });

  // --- Fuzzy name matching ---

  describe('findApp', () => {
    it('returns exact match', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom' }));
      expect(findApp(ADDR_A, 'manifest-doom')?.name).toBe('manifest-doom');
    });

    it('returns suffix match (e.g. "doom" matches "manifest-doom")', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('manifest-doom');
    });

    it('returns substring match', () => {
      addApp(ADDR_A, makeApp({ name: 'my-doom-app' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('my-doom-app');
    });

    it('returns null when no match', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-tetris' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('returns null on ambiguous match when multiple suffix matches exist', () => {
      addApp(ADDR_A, makeApp({ name: 'app-doom', leaseUuid: 'uuid-1' }));
      addApp(ADDR_A, makeApp({ name: 'game-doom', leaseUuid: 'uuid-2' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('returns null on ambiguous substring match', () => {
      addApp(ADDR_A, makeApp({ name: 'my-doom-app', leaseUuid: 'uuid-1' }));
      addApp(ADDR_A, makeApp({ name: 'doom-runner', leaseUuid: 'uuid-2' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('prefers active apps over stopped ones', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom', leaseUuid: 'uuid-1', status: 'stopped' }));
      addApp(ADDR_A, makeApp({ name: 'manifest-doom-2', leaseUuid: 'uuid-2', status: 'running' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('manifest-doom-2');
    });
  });

  // --- Reconciliation ---

  describe('reconcileWithChain', () => {
    it('marks running apps as stopped when lease is no longer active', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set());

      const updated = getApp(ADDR_A, app.name);
      expect(updated?.status).toBe('stopped');
    });

    it('marks deploying apps as stopped when lease is no longer active', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set());

      expect(getApp(ADDR_A, app.name)?.status).toBe('stopped');
    });

    it('does not change apps whose leases are still active', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set([app.leaseUuid]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });

    it('does not change already-stopped apps', () => {
      const app = makeApp({ status: 'stopped' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set());

      expect(getApp(ADDR_A, app.name)?.status).toBe('stopped');
    });

    it('keeps failed apps as failed when lease is not active', () => {
      const app = makeApp({ status: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set());

      expect(getApp(ADDR_A, app.name)?.status).toBe('failed');
    });

    it('restores failed apps to running when lease is still active', () => {
      const app = makeApp({ status: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Set([app.leaseUuid]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });
  });

  // --- Corruption recovery ---

  describe('corruption recovery', () => {
    it('returns empty array and clears storage on invalid JSON', () => {
      localStorage.setItem(`barney-apps-${ADDR_A}`, 'not json');
      expect(getApps(ADDR_A)).toEqual([]);
      expect(localStorage.getItem(`barney-apps-${ADDR_A}`)).toBeNull();
    });

    it('returns empty array and clears storage on non-array JSON', () => {
      localStorage.setItem(`barney-apps-${ADDR_A}`, '{"foo": "bar"}');
      expect(getApps(ADDR_A)).toEqual([]);
      expect(localStorage.getItem(`barney-apps-${ADDR_A}`)).toBeNull();
    });

    it('filters out entries with missing required fields', () => {
      const validApp = makeApp();
      const invalidEntry = { name: 'partial' }; // missing required fields
      localStorage.setItem(
        `barney-apps-${ADDR_A}`,
        JSON.stringify([validApp, invalidEntry])
      );

      const apps = getApps(ADDR_A);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('my-app');
    });
  });
});

describe('sanitizeManifestForStorage', () => {
  it('sanitizes sensitive env vars in single-service manifest', () => {
    const manifest = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'secret123', POSTGRES_DB: 'mydb' },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.env.POSTGRES_PASSWORD).toBe('');
    expect(result.env.POSTGRES_DB).toBe('mydb');
  });

  it('sanitizes sensitive env vars in stack manifest', () => {
    const manifest = JSON.stringify({
      services: {
        web: { image: 'wordpress', env: { WORDPRESS_DB_PASSWORD: 'secret' } },
        db: { image: 'mysql', env: { MYSQL_ROOT_PASSWORD: 'root_pass', MYSQL_DATABASE: 'mydb' } },
      },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.services.web.env.WORDPRESS_DB_PASSWORD).toBe('');
    expect(result.services.db.env.MYSQL_ROOT_PASSWORD).toBe('');
    expect(result.services.db.env.MYSQL_DATABASE).toBe('mydb');
  });

  it('returns empty JSON for invalid input', () => {
    expect(sanitizeManifestForStorage('not json')).toBe('{}');
  });

  it('preserves non-sensitive values in stack manifest', () => {
    const manifest = JSON.stringify({
      services: {
        web: { image: 'nginx', env: { PORT: '80' } },
      },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.services.web.env.PORT).toBe('80');
  });
});
