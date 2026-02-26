import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVersionedStorage } from './versionedStorage';

vi.mock('./errors', () => ({
  logError: vi.fn(),
}));

import { logError } from './errors';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('createVersionedStorage', () => {
  it('throws when migrations.length !== version', () => {
    expect(() =>
      createVersionedStorage({
        version: 2,
        migrations: [(d) => d], // only 1 migration for version 2
        validate: (d) => d as string,
      })
    ).toThrow('migrations.length (1) must equal version (2)');
  });

  describe('load', () => {
    it('returns null when key does not exist', () => {
      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('nonexistent')).toBeNull();
    });

    it('returns validated data from current-version envelope', () => {
      localStorage.setItem('key', JSON.stringify({ v: 1, data: 'hello' }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('key')).toBe('hello');
    });

    it('migrates legacy v0 data to current version', () => {
      // Legacy data: no envelope, just raw object
      localStorage.setItem('key', JSON.stringify({ old: true }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(old: unknown) => {
          const o = old as { old: boolean };
          return { migrated: o.old };
        }],
        validate: (d) => {
          const obj = d as { migrated?: boolean };
          return typeof obj.migrated === 'boolean' ? obj : null;
        },
      });

      expect(storage.load('key')).toEqual({ migrated: true });
    });

    it('runs multi-step migration chain (v0 → v1 → v2)', () => {
      localStorage.setItem('key', JSON.stringify({ name: 'alice' }));

      const storage = createVersionedStorage({
        version: 2,
        migrations: [
          // v0 → v1: add age field
          (old: unknown) => ({ ...(old as object), age: 0 }),
          // v1 → v2: rename name to fullName
          (old: unknown) => {
            const o = old as { name: string; age: number };
            return { fullName: o.name, age: o.age };
          },
        ],
        validate: (d) => {
          const obj = d as { fullName?: string; age?: number };
          return typeof obj.fullName === 'string' && typeof obj.age === 'number' ? obj : null;
        },
      });

      expect(storage.load('key')).toEqual({ fullName: 'alice', age: 0 });
    });

    it('returns null for future version (graceful degradation)', () => {
      localStorage.setItem('key', JSON.stringify({ v: 99, data: 'future' }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('key')).toBeNull();
    });

    it('returns null for negative version number', () => {
      localStorage.setItem('key', JSON.stringify({ v: -1, data: 'bad' }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('key')).toBeNull();
    });

    it('returns null for non-integer version number', () => {
      localStorage.setItem('key', JSON.stringify({ v: 1.5, data: 'bad' }));

      const storage = createVersionedStorage({
        version: 2,
        migrations: [(d) => d, (d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('key')).toBeNull();
    });

    it('returns null and logs error for corrupted JSON', () => {
      localStorage.setItem('key', 'not-json{{{');

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => (typeof d === 'string' ? d : null),
      });

      expect(storage.load('key')).toBeNull();
      expect(logError).toHaveBeenCalledWith('versionedStorage.load', expect.any(SyntaxError));
    });

    it('returns null when migration returns null', () => {
      localStorage.setItem('key', JSON.stringify({ bad: true }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [() => null],
        validate: (d) => d as string,
      });

      expect(storage.load('key')).toBeNull();
    });

    it('returns null when validate returns null', () => {
      localStorage.setItem('key', JSON.stringify({ v: 1, data: 42 }));

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: () => null,
      });

      expect(storage.load('key')).toBeNull();
    });

    it('migrates from intermediate version envelope', () => {
      // Stored as v1, current is v2
      localStorage.setItem('key', JSON.stringify({ v: 1, data: { count: 5 } }));

      const storage = createVersionedStorage({
        version: 2,
        migrations: [
          // v0 → v1 (not used in this test)
          (d) => d,
          // v1 → v2: double the count
          (old: unknown) => {
            const o = old as { count: number };
            return { count: o.count * 2 };
          },
        ],
        validate: (d) => {
          const obj = d as { count?: number };
          return typeof obj.count === 'number' ? obj : null;
        },
      });

      expect(storage.load('key')).toEqual({ count: 10 });
    });
  });

  describe('save', () => {
    it('writes versioned envelope to localStorage', () => {
      const storage = createVersionedStorage({
        version: 2,
        migrations: [(d) => d, (d) => d],
        validate: (d) => d as { x: number },
      });

      storage.save('key', { x: 42 });

      const raw = localStorage.getItem('key');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual({ v: 2, data: { x: 42 } });
    });
  });

  describe('clear', () => {
    it('removes key from localStorage', () => {
      localStorage.setItem('key', 'value');

      const storage = createVersionedStorage({
        version: 1,
        migrations: [(d) => d],
        validate: (d) => d as string,
      });

      storage.clear('key');
      expect(localStorage.getItem('key')).toBeNull();
    });
  });
});
