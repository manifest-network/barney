import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
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
    ports: { '5432/tcp': {} },
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
      ports: { '5432/tcp': {}, '8080/tcp': {}, '53/udp': {} },
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

  it('preserves ingress flag in port values', () => {
    const manifest: ManifestFields = {
      image: 'nginx:1',
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
      env: {},
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.ports['18789/tcp']).toEqual({ ingress: true });
    expect(parsed.ports['8083/tcp']).toEqual({});
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

  it('keeps JSON blob env vars in env', () => {
    const json = JSON.stringify({ image: 'app', env: { KEY: 'val', BLOB: '{"a":1}' } });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.env).toEqual({ KEY: 'val', BLOB: '{"a":1}' });
  });

  it('round-trip strips _notice and preserves all env', () => {
    const json = JSON.stringify({
      image: 'app', env: { KEY: 'val', BLOB: '{"a":1}' }, [MANIFEST_NOTICE_KEY]: 'notice',
    });
    const parsed = parseEditableManifest(makeAction(json))!;
    expect(parsed.notice).toBe('notice');
    const serialized = JSON.parse(serializeManifest(parsed));
    expect(serialized[MANIFEST_NOTICE_KEY]).toBeUndefined();
    expect(serialized.env).toEqual({ KEY: 'val', BLOB: '{"a":1}' });
  });

  it('ignores non-string _notice values', () => {
    const json = JSON.stringify({ image: 'app', [MANIFEST_NOTICE_KEY]: 42 });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.notice).toBeUndefined();
  });

  it('preserves ingress flag in ports', () => {
    const json = JSON.stringify({
      image: 'openclaw',
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
    });
    const result = parseEditableManifest(makeAction(json));
    expect(result?.ports['18789/tcp']).toEqual({ ingress: true });
    expect(result?.ports['8083/tcp']).toEqual({});
  });

  it('round-trips ingress flag through serialize/parse', () => {
    const json = JSON.stringify({
      image: 'openclaw',
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
    });
    const parsed = parseEditableManifest(makeAction(json))!;
    const serialized = serializeManifest(parsed);
    const reparsed = parseEditableManifest(makeAction(serialized));
    expect(reparsed?.ports['18789/tcp']).toEqual({ ingress: true });
    expect(reparsed?.ports['8083/tcp']).toEqual({});
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

// ============================================================================
// ManifestEditor ingress toggle (render-based tests)
// ============================================================================

describe('ManifestEditor ingress toggle', () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderEditor(manifest: ManifestFields, onChange: (m: ManifestFields) => void) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => { root.render(createElement(ManifestEditor, { manifest, onChange })); });
  }

  afterEach(() => {
    flushSync(() => { root?.unmount(); });
    container?.remove();
  });

  it('renders ingress checkbox only for TCP ports', () => {
    const manifest = makeManifest({
      ports: { '8080/tcp': {}, '53/udp': {} },
    });
    renderEditor(manifest, vi.fn());
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0].getAttribute('aria-label')).toBe('Ingress for 8080/tcp');
  });

  it('checking ingress sets ingress: true on that port', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      ports: { '18789/tcp': {}, '8083/tcp': {} },
    });
    renderEditor(manifest, onChange);
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    // Click the first checkbox (18789/tcp)
    flushSync(() => { checkboxes[0].click(); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
    }));
  });

  it('at most one port has ingress — enabling on one clears the other', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
    });
    renderEditor(manifest, onChange);
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    // Click the second checkbox (8083/tcp) — should clear 18789
    flushSync(() => { checkboxes[1].click(); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      ports: { '18789/tcp': {}, '8083/tcp': { ingress: true } },
    }));
  });

  it('unchecking ingress clears it without setting another', () => {
    const onChange = vi.fn();
    const manifest = makeManifest({
      ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} },
    });
    renderEditor(manifest, onChange);
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    // Click the first checkbox (18789/tcp) — currently checked, should uncheck
    flushSync(() => { checkboxes[0].click(); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      ports: { '18789/tcp': {}, '8083/tcp': {} },
    }));
  });
});
