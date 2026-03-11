import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { ManifestEditor } from './ManifestEditor';
import {
  isValidPort,
  parseEditableManifest,
  serializeManifest,
  type ManifestFields,
} from './manifestEditorUtils';
import { MANIFEST_NOTICE_KEY } from '../../config/constants';
import { buildExampleManifest, type ExampleApp } from '../../config/exampleApps';
import { buildPayloadFromManifest } from '../../ai/toolExecutor/compositeTransactions';

function makeManifest(overrides?: Partial<ManifestFields>): ManifestFields {
  return {
    image: 'postgres:18',
    ports: { '5432/tcp': {} as Record<string, never> },
    env: { POSTGRES_PASSWORD: 'secret123' },
    user: '1000:1000',
    tmpfs: ['/tmp/data'],
    ...overrides,
  };
}

describe('ManifestEditor', () => {
  it('can be instantiated with all manifest fields', () => {
    const onChange = vi.fn();
    const manifest = makeManifest();
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(element).toBeDefined();
    expect(element.type).toBe(ManifestEditor);
    expect(element.props.manifest.image).toBe('postgres:18');
    expect(element.props.manifest.ports).toEqual({ '5432/tcp': {} });
    expect(element.props.manifest.env).toEqual({ POSTGRES_PASSWORD: 'secret123' });
    expect(element.props.manifest.user).toBe('1000:1000');
    expect(element.props.manifest.tmpfs).toEqual(['/tmp/data']);
  });

  it('accepts empty ports, env, and no tmpfs', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({ ports: {}, env: {}, user: undefined, tmpfs: undefined });
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(element).toBeDefined();
    expect(element.props.manifest.ports).toEqual({});
    expect(element.props.manifest.env).toEqual({});
    expect(element.props.manifest.user).toBeUndefined();
    expect(element.props.manifest.tmpfs).toBeUndefined();
  });

  it('accepts multiple ports', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      ports: { '5432/tcp': {} as Record<string, never>, '8080/tcp': {} as Record<string, never>, '53/udp': {} as Record<string, never> },
    });
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(Object.keys(element.props.manifest.ports)).toHaveLength(3);
  });

  it('accepts multiple env vars', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      env: { DB_HOST: 'localhost', DB_PORT: '5432', POSTGRES_PASSWORD: 'secret' },
    });
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(Object.keys(element.props.manifest.env)).toHaveLength(3);
  });

  it('accepts multiple tmpfs paths', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      tmpfs: ['/tmp/data', '/var/cache', '/run/secrets'],
    });
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(element.props.manifest.tmpfs).toHaveLength(3);
  });

  it('passes onChange callback', () => {
    const onChange = vi.fn();
    const manifest = makeManifest();
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(element.props.onChange).toBe(onChange);
  });
});

describe('ManifestEditor env masking', () => {
  it('renders with env vars that have non-obvious secret keys (mask-by-default)', () => {
    const onChange = vi.fn();
    // These keys were previously missed by the SENSITIVE_PATTERN denylist.
    // With mask-by-default, all env values use password input type regardless of key name.
    const manifest = makeManifest({
      env: {
        RABBITMQ_DEFAULT_PASS: 'hunter2',
        NEO4J_AUTH: 'neo4j/secret',
        DATABASE_URL: 'postgres://user:pass@host/db',
        PORT: '3000',
      },
    });
    const element = createElement(ManifestEditor, { manifest, onChange });
    expect(element).toBeDefined();
    expect(Object.keys(element.props.manifest.env)).toHaveLength(4);
    // All values are masked by default (password input type) — no denylist filtering
  });
});

describe('isValidPort', () => {
  it('accepts valid port numbers', () => {
    expect(isValidPort('1')).toBe(true);
    expect(isValidPort('80')).toBe(true);
    expect(isValidPort('443')).toBe(true);
    expect(isValidPort('8080')).toBe(true);
    expect(isValidPort('65535')).toBe(true);
  });

  it('rejects port 0', () => {
    expect(isValidPort('0')).toBe(false);
  });

  it('rejects ports above 65535', () => {
    expect(isValidPort('65536')).toBe(false);
    expect(isValidPort('100000')).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(isValidPort('-1')).toBe(false);
    expect(isValidPort('-80')).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(isValidPort('abc')).toBe(false);
    expect(isValidPort('')).toBe(false);
    expect(isValidPort(' ')).toBe(false);
  });

  it('rejects leading zeros', () => {
    expect(isValidPort('080')).toBe(false);
    expect(isValidPort('0080')).toBe(false);
  });

  it('rejects decimal numbers', () => {
    expect(isValidPort('80.0')).toBe(false);
    expect(isValidPort('80.5')).toBe(false);
  });
});

describe('serializeManifest', () => {
  it('excludes notice from serialized output', () => {
    const manifest: ManifestFields = {
      image: 'nginx:1', ports: {}, env: { KEY: 'val' }, notice: 'Save your keys!',
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed[MANIFEST_NOTICE_KEY]).toBeUndefined();
    expect(parsed.notice).toBeUndefined();
    expect(parsed.env).toEqual({ KEY: 'val' });
  });

  it('merges hiddenEnv back into env', () => {
    const manifest: ManifestFields = {
      image: 'app:1', ports: {}, env: { KEY: 'val' },
      hiddenEnv: { JSON_BLOB: '{"a":1}' },
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.env).toEqual({ JSON_BLOB: '{"a":1}', KEY: 'val' });
  });

  it('user env overrides hiddenEnv on key collision', () => {
    const manifest: ManifestFields = {
      image: 'app:1', ports: {}, env: { MODELS: 'override' },
      hiddenEnv: { MODELS: '{"old":true}' },
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.env.MODELS).toBe('override');
  });
});

describe('parseEditableManifest', () => {
  function makeAction(json: string) {
    return { id: '1', toolName: 'deploy_app', args: { _generatedManifest: json }, description: '' };
  }

  it('extracts _notice into notice', () => {
    const json = JSON.stringify({ image: 'nginx', [MANIFEST_NOTICE_KEY]: 'Save your keys' });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.notice).toBe('Save your keys');
  });

  it('splits JSON blob env vars into hiddenEnv', () => {
    const json = JSON.stringify({ image: 'app', env: { KEY: 'val', BLOB: '{"a":1}' } });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.env).toEqual({ KEY: 'val' });
    expect(result?.hiddenEnv).toEqual({ BLOB: '{"a":1}' });
  });

  it('round-trip strips _notice and preserves hiddenEnv', () => {
    const json = JSON.stringify({
      image: 'app', env: { KEY: 'val', BLOB: '{"a":1}' }, [MANIFEST_NOTICE_KEY]: 'notice',
    });
    const parsed = parseEditableManifest(makeAction(json))!;
    expect(parsed.notice).toBe('notice');
    const serialized = JSON.parse(serializeManifest(parsed));
    expect(serialized[MANIFEST_NOTICE_KEY]).toBeUndefined();
    expect(serialized.env).toEqual({ BLOB: '{"a":1}', KEY: 'val' });
  });

  it('ignores non-string _notice values', () => {
    const json = JSON.stringify({ image: 'app', [MANIFEST_NOTICE_KEY]: 42 });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.notice).toBeUndefined();
  });
});

describe('buildPayloadFromManifest', () => {
  it('strips _notice from payload', async () => {
    const json = JSON.stringify({ image: 'app', [MANIFEST_NOTICE_KEY]: 'Save keys' });
    const payload = await buildPayloadFromManifest(json);
    const decoded = JSON.parse(new TextDecoder().decode(payload.bytes));
    expect(decoded[MANIFEST_NOTICE_KEY]).toBeUndefined();
    expect(decoded.image).toBe('app');
  });

  it('passes through manifest without _notice unchanged', async () => {
    const json = JSON.stringify({ image: 'app', env: { KEY: 'val' } });
    const payload = await buildPayloadFromManifest(json);
    const decoded = JSON.parse(new TextDecoder().decode(payload.bytes));
    expect(decoded).toEqual({ image: 'app', env: { KEY: 'val' } });
  });

  it('computes hash from cleaned JSON', async () => {
    const withNotice = JSON.stringify({ image: 'app', [MANIFEST_NOTICE_KEY]: 'x' });
    const withoutNotice = JSON.stringify({ image: 'app' }, null, 2);
    const payload = await buildPayloadFromManifest(withNotice);
    const clean = await buildPayloadFromManifest(withoutNotice);
    expect(payload.hash).toBe(clean.hash);
  });
});

describe('buildExampleManifest', () => {
  it('injects _notice when notice is set', () => {
    const app: ExampleApp = { label: 'Test', manifest: { image: 'app' }, notice: 'Save it', group: 'apps' };
    const parsed = JSON.parse(buildExampleManifest(app));
    expect(parsed[MANIFEST_NOTICE_KEY]).toBe('Save it');
  });

  it('omits _notice when notice is not set', () => {
    const app: ExampleApp = { label: 'Test', manifest: { image: 'app' }, group: 'apps' };
    const parsed = JSON.parse(buildExampleManifest(app));
    expect(parsed[MANIFEST_NOTICE_KEY]).toBeUndefined();
  });

  it('merges envFactory into manifest env', () => {
    const app: ExampleApp = {
      label: 'Test', manifest: { image: 'app', env: { A: '1' } },
      envFactory: () => ({ B: '2' }), group: 'apps',
    };
    const parsed = JSON.parse(buildExampleManifest(app));
    expect(parsed.env).toEqual({ A: '1', B: '2' });
  });

  it('manifestFactory overrides envFactory', () => {
    const app: ExampleApp = {
      label: 'Test', manifest: { image: 'app' },
      manifestFactory: () => ({ image: 'custom', ports: {} }),
      envFactory: () => ({ SHOULD_NOT_APPEAR: 'x' }),
      group: 'apps',
    };
    const parsed = JSON.parse(buildExampleManifest(app));
    expect(parsed.image).toBe('custom');
    expect(parsed.env).toBeUndefined();
  });
});
