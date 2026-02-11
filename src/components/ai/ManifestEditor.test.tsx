import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { ManifestEditor } from './ManifestEditor';
import { isValidPort, type ManifestFields } from './manifestEditorUtils';

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
