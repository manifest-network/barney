import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { ConfirmationCard } from './ConfirmationCard';
import { parseEditableManifest, serializeManifest, type ManifestFields } from './manifestEditorUtils';
import type { PendingAction } from '../../ai/toolExecutor';

function makeAction(overrides?: Partial<PendingAction>): PendingAction {
  return {
    id: 'test-action',
    toolName: 'fund_credits',
    args: { amount: 10 },
    description: 'Add 10 credits?',
    ...overrides,
  };
}

describe('ConfirmationCard', () => {
  it('can be instantiated with non-deploy action', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action = makeAction({ toolName: 'fund_credits' });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.type).toBe(ConfirmationCard);
    expect(element.props.action.toolName).toBe('fund_credits');
  });

  it('can be instantiated for stop_app action', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action = makeAction({
      toolName: 'stop_app',
      args: { app_name: 'my-app', leaseUuid: 'uuid-123' },
      description: 'Stop app "my-app"?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.props.action.toolName).toBe('stop_app');
  });

  it('accepts isExecuting prop', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action = makeAction();
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel, isExecuting: true });
    expect(element.props.isExecuting).toBe(true);
  });

  it('can be instantiated for deploy_app with _generatedManifest (editable)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const manifest = JSON.stringify({
      image: 'postgres:18',
      ports: { '5432/tcp': {} },
      env: { POSTGRES_PASSWORD: 'secret' },
    });
    const action = makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'postgres', size: 'micro', _generatedManifest: manifest },
      description: 'Deploy "postgres" on micro tier?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.props.action.toolName).toBe('deploy_app');
    expect(element.props.action.args._generatedManifest).toBe(manifest);
  });

  it('can be instantiated for update_app with _generatedManifest (editable)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const manifest = JSON.stringify({
      image: 'redis:8',
      ports: { '6379/tcp': {} },
    });
    const action = makeAction({
      toolName: 'update_app',
      args: { app_name: 'redis', _generatedManifest: manifest },
      description: 'Update "redis"?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.props.action.toolName).toBe('update_app');
  });

  it('remains read-only for deploy_app without _generatedManifest (file-attached)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action = makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'my-app', size: 'micro' },
      description: 'Deploy "my-app"?',
      payload: {
        bytes: new Uint8Array([123, 125]),
        filename: 'manifest.json',
        size: 2,
        hash: 'abc123',
      },
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.props.action.args._generatedManifest).toBeUndefined();
  });

  it('receives onConfirm that accepts optional string', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const action = makeAction();
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element.props.onConfirm).toBe(onConfirm);
  });
});

describe('parseEditableManifest', () => {
  it('returns null for non-deploy tools', () => {
    expect(parseEditableManifest(makeAction({ toolName: 'fund_credits' }))).toBeNull();
    expect(parseEditableManifest(makeAction({ toolName: 'stop_app' }))).toBeNull();
    expect(parseEditableManifest(makeAction({ toolName: 'restart_app' }))).toBeNull();
    expect(parseEditableManifest(makeAction({ toolName: 'cosmos_tx' }))).toBeNull();
  });

  it('returns null when _generatedManifest is missing', () => {
    expect(parseEditableManifest(makeAction({ toolName: 'deploy_app', args: { app_name: 'x' } }))).toBeNull();
  });

  it('returns null when _generatedManifest is not a string', () => {
    expect(parseEditableManifest(makeAction({ toolName: 'deploy_app', args: { _generatedManifest: 123 } }))).toBeNull();
    expect(parseEditableManifest(makeAction({ toolName: 'deploy_app', args: { _generatedManifest: true } }))).toBeNull();
    expect(parseEditableManifest(makeAction({ toolName: 'deploy_app', args: { _generatedManifest: {} } }))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: { _generatedManifest: 'not-json' },
    }))).toBeNull();
  });

  it('parses a full manifest for deploy_app', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({
          image: 'postgres:18',
          ports: { '5432/tcp': {} },
          env: { POSTGRES_PASSWORD: 'secret' },
          user: '1000:1000',
          tmpfs: ['/tmp/data'],
        }),
      },
    }));
    expect(result).toEqual({
      image: 'postgres:18',
      ports: { '5432/tcp': {} },
      env: { POSTGRES_PASSWORD: 'secret' },
      user: '1000:1000',
      tmpfs: ['/tmp/data'],
    });
  });

  it('parses a manifest for update_app', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'update_app',
      args: {
        _generatedManifest: JSON.stringify({ image: 'redis:8', ports: { '6379/tcp': {} } }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.image).toBe('redis:8');
  });

  it('defaults missing optional fields', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({ image: 'nginx' }),
      },
    }));
    expect(result).toEqual({
      image: 'nginx',
      ports: {},
      env: {},
      user: undefined,
      tmpfs: undefined,
    });
  });

  it('ignores extra unknown fields', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({ image: 'nginx', unknownField: 'value' }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.image).toBe('nginx');
    expect((result as unknown as Record<string, unknown>)['unknownField']).toBeUndefined();
  });
});

describe('serializeManifest', () => {
  it('includes all non-empty fields', () => {
    const manifest: ManifestFields = {
      image: 'postgres:18',
      ports: { '5432/tcp': {} as Record<string, never> },
      env: { POSTGRES_PASSWORD: 'secret' },
      user: '1000:1000',
      tmpfs: ['/tmp/data'],
    };
    const json = serializeManifest(manifest);
    const parsed = JSON.parse(json);
    expect(parsed.image).toBe('postgres:18');
    expect(parsed.ports).toEqual({ '5432/tcp': {} });
    expect(parsed.env).toEqual({ POSTGRES_PASSWORD: 'secret' });
    expect(parsed.user).toBe('1000:1000');
    expect(parsed.tmpfs).toEqual(['/tmp/data']);
  });

  it('omits empty ports', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: {}, env: { KEY: 'val' } };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.ports).toBeUndefined();
    expect(parsed.env).toEqual({ KEY: 'val' });
  });

  it('omits empty env', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: { '80/tcp': {} as Record<string, never> }, env: {} };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.env).toBeUndefined();
    expect(parsed.ports).toEqual({ '80/tcp': {} });
  });

  it('omits undefined user', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: {}, env: {}, user: undefined };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.user).toBeUndefined();
  });

  it('omits empty string user', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: {}, env: {}, user: '' };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.user).toBeUndefined();
  });

  it('omits undefined tmpfs', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: {}, env: {} };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.tmpfs).toBeUndefined();
  });

  it('omits empty tmpfs array', () => {
    const manifest: ManifestFields = { image: 'nginx', ports: {}, env: {}, tmpfs: [] };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.tmpfs).toBeUndefined();
  });

  it('always includes image even as only field', () => {
    const manifest: ManifestFields = { image: 'alpine', ports: {}, env: {} };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed).toEqual({ image: 'alpine' });
  });

  it('round-trips through parseEditableManifest', () => {
    const original: ManifestFields = {
      image: 'postgres:18',
      ports: { '5432/tcp': {} as Record<string, never> },
      env: { DB_NAME: 'mydb', POSTGRES_PASSWORD: 'secret' },
      user: '999:999',
      tmpfs: ['/tmp/data', '/var/cache'],
    };
    const json = serializeManifest(original);
    const action = makeAction({
      toolName: 'deploy_app',
      args: { _generatedManifest: json },
    });
    const roundTripped = parseEditableManifest(action);
    expect(roundTripped).toEqual(original);
  });
});
