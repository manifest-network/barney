import { logError } from './errors';

interface Envelope {
  v: number;
  data: unknown;
}

interface VersionedStorageConfig<T> {
  version: number;
  /** migrations[0] upgrades v0→v1, migrations[1] upgrades v1→v2, etc. Return null to discard. */
  migrations: Array<(old: unknown) => unknown>;
  /** Return parsed T or null if data is invalid. */
  validate: (data: unknown) => T | null;
}

interface VersionedStorage<T> {
  load: (key: string) => T | null;
  save: (key: string, data: T) => void;
  clear: (key: string) => void;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'v' in value &&
    typeof (value as Envelope).v === 'number' &&
    'data' in value
  );
}

export function createVersionedStorage<T>(config: VersionedStorageConfig<T>): VersionedStorage<T> {
  const { version, migrations, validate } = config;

  if (migrations.length !== version) {
    throw new Error(
      `versionedStorage: migrations.length (${migrations.length}) must equal version (${version})`
    );
  }

  function load(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;

      const parsed: unknown = JSON.parse(raw);

      let currentVersion: number;
      let data: unknown;

      if (isEnvelope(parsed)) {
        currentVersion = parsed.v;
        data = parsed.data;
      } else {
        // Legacy unversioned data — treat as v0
        currentVersion = 0;
        data = parsed;
      }

      if (currentVersion > version) {
        // Future version — graceful degradation
        return null;
      }

      if (currentVersion < version) {
        for (let v = currentVersion; v < version; v++) {
          data = migrations[v](data);
          if (data === null) return null;
        }
      }

      return validate(data);
    } catch (error) {
      logError('versionedStorage.load', error);
      return null;
    }
  }

  function save(key: string, data: T): void {
    try {
      const envelope: Envelope = { v: version, data };
      localStorage.setItem(key, JSON.stringify(envelope));
    } catch (error) {
      logError('versionedStorage.save', error);
    }
  }

  function clear(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      logError('versionedStorage.clear', error);
    }
  }

  return { load, save, clear };
}
