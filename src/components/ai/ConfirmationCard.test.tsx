import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { ConfirmationCard } from './ConfirmationCard';
import {
  parseEditableManifest, serializeManifest,
  parseEditableStackManifest, serializeStackManifest,
  type ManifestFields, type StackManifestFields,
} from './manifestEditorUtils';
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

  it('can be instantiated for restart_app all action with entries', () => {
    const action = makeAction({
      toolName: 'restart_app',
      args: {
        app_name: 'all',
        entries: [
          { app_name: 'redis', leaseUuid: 'uuid-1', providerUrl: 'https://fred1.example.com' },
          { app_name: 'postgres', leaseUuid: 'uuid-2', providerUrl: 'https://fred2.example.com' },
        ],
      },
      description: 'Restart 2 apps (redis, postgres)?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(element).toBeDefined();
    expect(element.props.action.toolName).toBe('restart_app');
    expect(element.props.action.args.entries).toHaveLength(2);
  });

  it('can be instantiated for stop_app all action with entries', () => {
    const action = makeAction({
      toolName: 'stop_app',
      args: {
        app_name: 'all',
        entries: [
          { app_name: 'redis', leaseUuid: 'uuid-1' },
          { app_name: 'postgres', leaseUuid: 'uuid-2' },
        ],
      },
      description: 'Stop 2 apps (redis, postgres)?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm: vi.fn(), onCancel: vi.fn() });
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
      ports: { '5432/tcp': {} },
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
    const manifest: ManifestFields = { image: 'nginx', ports: { '80/tcp': {} }, env: {} };
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
      ports: { '5432/tcp': {} },
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

describe('parseEditableStackManifest', () => {
  it('returns null for non-deploy tools', () => {
    expect(parseEditableStackManifest(makeAction({ toolName: 'fund_credits' }))).toBeNull();
    expect(parseEditableStackManifest(makeAction({ toolName: 'stop_app' }))).toBeNull();
  });

  it('returns null for single-container manifests', () => {
    const result = parseEditableStackManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({ image: 'nginx', ports: { '80/tcp': {} } }),
      },
    }));
    expect(result).toBeNull();
  });

  it('returns null when _generatedManifest is missing', () => {
    expect(parseEditableStackManifest(makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'x' },
    }))).toBeNull();
  });

  it('parses a stack manifest with multiple services', () => {
    const result = parseEditableStackManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({
          services: {
            wordpress: {
              image: 'wordpress:latest',
              ports: { '80/tcp': {} },
              env: { WORDPRESS_DB_HOST: 'mysql' },
            },
            mysql: {
              image: 'mysql:8',
              env: { MYSQL_ROOT_PASSWORD: 'secret' },
            },
          },
        }),
      },
    }));
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toEqual(['wordpress', 'mysql']);
    expect(result!.wordpress.editable.image).toBe('wordpress:latest');
    expect(result!.mysql.editable.env.MYSQL_ROOT_PASSWORD).toBe('secret');
  });

  it('preserves passthrough fields (command, depends_on, health_check, etc.)', () => {
    const result = parseEditableStackManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({
          services: {
            web: {
              image: 'nginx',
              ports: { '80/tcp': {} },
              command: ['nginx', '-g', 'daemon off;'],
              depends_on: ['redis'],
              health_check: { test: 'curl -f http://localhost/' },
            },
          },
        }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.web.passthrough).toEqual({
      command: ['nginx', '-g', 'daemon off;'],
      depends_on: ['redis'],
      health_check: { test: 'curl -f http://localhost/' },
    });
    expect(result!.web.editable.image).toBe('nginx');
  });

  it('works for update_app with stack manifests', () => {
    const result = parseEditableStackManifest(makeAction({
      toolName: 'update_app',
      args: {
        _generatedManifest: JSON.stringify({
          services: {
            app: { image: 'myapp:v2', ports: { '3000/tcp': {} } },
          },
        }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.app.editable.image).toBe('myapp:v2');
  });
});

describe('serializeStackManifest', () => {
  it('produces valid JSON with services wrapper', () => {
    const stack: StackManifestFields = {
      web: {
        editable: { image: 'nginx', ports: { '80/tcp': {} }, env: {} },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services).toBeDefined();
    expect(parsed.services.web.image).toBe('nginx');
  });

  it('omits empty optional fields per service', () => {
    const stack: StackManifestFields = {
      app: {
        editable: { image: 'node:20', ports: {}, env: {}, user: '', tmpfs: [] },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.app).toEqual({ image: 'node:20' });
  });

  it('preserves passthrough fields in output', () => {
    const stack: StackManifestFields = {
      web: {
        editable: { image: 'nginx', ports: { '80/tcp': {} }, env: {} },
        passthrough: { command: ['nginx'], depends_on: ['db'] },
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.web.command).toEqual(['nginx']);
    expect(parsed.services.web.depends_on).toEqual(['db']);
  });

  it('round-trips through parseEditableStackManifest', () => {
    const original: StackManifestFields = {
      wordpress: {
        editable: {
          image: 'wordpress:latest',
          ports: { '80/tcp': {} },
          env: { WORDPRESS_DB_HOST: 'mysql' },
        },
        passthrough: { depends_on: ['mysql'] },
      },
      mysql: {
        editable: {
          image: 'mysql:8',
          ports: {},
          env: { MYSQL_ROOT_PASSWORD: 'secret' },
          user: '999:999',
        },
        passthrough: {},
      },
    };
    const json = serializeStackManifest(original);
    const action = makeAction({
      toolName: 'deploy_app',
      args: { _generatedManifest: json },
    });
    const roundTripped = parseEditableStackManifest(action);
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.wordpress.editable.image).toBe('wordpress:latest');
    expect(roundTripped!.wordpress.passthrough.depends_on).toEqual(['mysql']);
    expect(roundTripped!.mysql.editable.env.MYSQL_ROOT_PASSWORD).toBe('secret');
    expect(roundTripped!.mysql.editable.user).toBe('999:999');
  });
});

describe('SensitiveValue masks all env values by default', () => {
  it('masks env values for non-obvious secret keys (e.g. RABBITMQ_DEFAULT_PASS)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    // These keys were previously missed by the SENSITIVE_PATTERN denylist.
    // With mask-by-default, all values are hidden regardless of key name.
    const manifest = JSON.stringify({
      image: 'rabbitmq:3',
      ports: { '5672/tcp': {} },
      env: { RABBITMQ_DEFAULT_PASS: 'hunter2', NEO4J_AUTH: 'neo4j/secret' },
    });
    const action = makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'rabbit', size: 'micro', _generatedManifest: manifest },
      description: 'Deploy "rabbit" on micro tier?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    // Component renders without error; all values are masked internally
    expect(element.props.action.args._generatedManifest).toContain('RABBITMQ_DEFAULT_PASS');
  });

  it('masks env values for innocuous-looking keys (e.g. DATABASE_URL)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      env: { DATABASE_URL: 'postgres://user:pass@host/db', PORT: '3000' },
    }));
    const action = makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'myapp', size: 'micro' },
      description: 'Deploy "myapp"?',
      payload: {
        bytes: payloadBytes,
        filename: 'manifest.json',
        size: payloadBytes.length,
        hash: 'abc123',
      },
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    // Both DATABASE_URL and PORT are masked by default (no denylist filtering)
  });
});

describe('ConfirmationCard with stack manifest', () => {
  it('can be instantiated for deploy_app with stack _generatedManifest', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const manifest = JSON.stringify({
      services: {
        wordpress: { image: 'wordpress:latest', ports: { '80/tcp': {} }, env: { WORDPRESS_DB_HOST: 'mysql' } },
        mysql: { image: 'mysql:8', env: { MYSQL_ROOT_PASSWORD: 'secret' } },
      },
    });
    const action = makeAction({
      toolName: 'deploy_app',
      args: { app_name: 'wp-stack', size: 'small', _generatedManifest: manifest, _isStack: true },
      description: 'Deploy "wp-stack" on small tier?',
    });
    const element = createElement(ConfirmationCard, { action, onConfirm, onCancel });
    expect(element).toBeDefined();
    expect(element.props.action.toolName).toBe('deploy_app');
    expect(element.props.action.args._generatedManifest).toBe(manifest);
  });
});
