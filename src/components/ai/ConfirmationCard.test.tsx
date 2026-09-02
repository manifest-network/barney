import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ResolvedSkuTier } from '../../api/skuTiers';

// Stub validateAll so the async-validate effect resolves deterministically
// without hitting the (mocked) chain RPC for reserved-suffix params. The
// stub mirrors the sync validators so format / IP / apex checks still apply.
vi.mock('../../utils/customDomainValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/customDomainValidation')>();
  return {
    ...actual,
    validateAll: vi.fn(async (fqdn: string) => {
      const formatError = actual.validateCustomDomainFormat(fqdn);
      if (formatError) return { error: formatError };
      if (actual.isApex(fqdn)) return { warning: actual.APEX_WARNING };
      return {};
    }),
  };
});

let mockSkuTiers: {
  phase: 'ready';
  tiers: ResolvedSkuTier[];
  denomSymbol: string;
  error: null;
} = { phase: 'ready', tiers: [], denomSymbol: 'PWR', error: null };

// ConfirmationCard reads `skuTiers` from useAI for deploy and batch pricing.
// Keep the default catalog empty, while allowing batch-tier tests to install
// concrete tiers without mounting an AIProvider.
vi.mock('../../hooks/useAI', () => ({
  useAI: () => ({
    skuTiers: mockSkuTiers,
  }),
}));

import { ConfirmationCard } from './ConfirmationCard';
import {
  parseEditableManifest, serializeManifest,
  parseEditableStackManifest, serializeStackManifest,
  type ManifestFields, type StackManifestFields,
} from './manifestEditorUtils';
import type { PendingAction } from '../../ai/toolExecutor';

beforeEach(() => {
  mockSkuTiers = { phase: 'ready', tiers: [], denomSymbol: 'PWR', error: null };
});

function makeAction(overrides?: Partial<PendingAction>): PendingAction {
  return {
    id: 'test-action',
    toolName: 'fund_credits',
    args: { amount: 10 },
    description: 'Add 10 credits?',
    ...overrides,
    originAddress: overrides?.originAddress ?? 'manifest1test',
    chainId: overrides?.chainId ?? 'manifest-test',
    clientGeneration: overrides?.clientGeneration ?? 1,
    signerGeneration: overrides?.signerGeneration ?? 1,
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

  it('preserves non-editable fields in passthrough', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({
          image: 'ghcr.io/paperclipai/paperclip:sha-5b47965',
          ports: { '3100/tcp': {} },
          env: { BETTER_AUTH_SECRET: 'secret' },
          user: '1000:1000',
          command: ['/bin/sh', '-c'],
          args: ['exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js'],
          health_check: { test: ['CMD-SHELL', 'curl -f http://localhost:3100/'], interval: '10s' },
        }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.image).toBe('ghcr.io/paperclipai/paperclip:sha-5b47965');
    expect(result!.passthrough).toEqual({
      command: ['/bin/sh', '-c'],
      args: ['exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js'],
      health_check: { test: ['CMD-SHELL', 'curl -f http://localhost:3100/'], interval: '10s' },
    });
  });

  it('sets passthrough to undefined when no non-editable fields exist', () => {
    const result = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: {
        _generatedManifest: JSON.stringify({ image: 'nginx', ports: { '80/tcp': {} } }),
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.passthrough).toBeUndefined();
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

  it('includes passthrough fields in output', () => {
    const manifest: ManifestFields = {
      image: 'ghcr.io/paperclipai/paperclip:sha-5b47965',
      ports: { '3100/tcp': {} },
      env: { BETTER_AUTH_SECRET: 'secret' },
      user: '1000:1000',
      passthrough: {
        command: ['/bin/sh', '-c'],
        args: ['exec node server/dist/index.js'],
      },
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.command).toEqual(['/bin/sh', '-c']);
    expect(parsed.args).toEqual(['exec node server/dist/index.js']);
    expect(parsed.image).toBe('ghcr.io/paperclipai/paperclip:sha-5b47965');
    expect(parsed.passthrough).toBeUndefined();
  });

  it('editable fields take precedence over passthrough', () => {
    const manifest: ManifestFields = {
      image: 'nginx:latest',
      ports: { '80/tcp': {} },
      env: { KEY: 'new' },
      passthrough: { env: { KEY: 'old' }, ports: { '9090/tcp': {} } },
    };
    const parsed = JSON.parse(serializeManifest(manifest));
    expect(parsed.env).toEqual({ KEY: 'new' });
    expect(parsed.ports).toEqual({ '80/tcp': {} });
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

  it('round-trips passthrough fields through parse and serialize', () => {
    const manifestJson = JSON.stringify({
      image: 'ghcr.io/paperclipai/paperclip:sha-5b47965',
      ports: { '3100/tcp': {} },
      env: { BETTER_AUTH_SECRET: 'secret' },
      user: '1000:1000',
      command: ['/bin/sh', '-c'],
      args: ['exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js'],
    });
    const parsed = parseEditableManifest(makeAction({
      toolName: 'deploy_app',
      args: { _generatedManifest: manifestJson },
    }));
    expect(parsed).not.toBeNull();
    const serialized = JSON.parse(serializeManifest(parsed!));
    expect(serialized.command).toEqual(['/bin/sh', '-c']);
    expect(serialized.args).toEqual(['exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js']);
    expect(serialized.image).toBe('ghcr.io/paperclipai/paperclip:sha-5b47965');
    expect(serialized.user).toBe('1000:1000');
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

  describe('set_custom_domain branch', () => {
    function renderInto(action: PendingAction) {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      flushSync(() => { root.render(createElement(ConfirmationCard, { action, onConfirm: vi.fn(), onCancel: vi.fn() })); });
      return { container, cleanup: () => { flushSync(() => { root.unmount(); }); container.remove(); } };
    }

    it('renders DNS table with CNAME target on attach', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: 'app.example.com',
          currentDomain: '',
          expectedCnameTarget: 'auto.barney0.manifest0.net',
        },
        description: 'Attach "app.example.com" to "my-api"?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const text = container.textContent ?? '';
        expect(text).toContain('CNAME');
        expect(text).toContain('app.example.com');
        expect(text).toContain('auto.barney0.manifest0.net');
        expect(text).toMatch(/orange-cloud proxy/i);
      } finally {
        cleanup();
      }
    });

    it('renders apex warning when warning provided AND switches Type cell to ALIAS / ANAME / CNAME-flattened', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: 'example.com',
          currentDomain: '',
          expectedCnameTarget: 'auto.barney0.manifest0.net',
          warning: 'This is an apex domain. Use ALIAS / ANAME / CNAME-flattening.',
        },
        description: 'Attach "example.com"?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const text = container.textContent ?? '';
        expect(text).toMatch(/apex/i);
        // Type cell must reflect the apex constraint, not "CNAME".
        expect(text).toMatch(/ALIAS \/ ANAME \/ CNAME-flattened/);
        // Verify the bare "CNAME" text doesn't appear in the Type cell — the only
        // remaining "CNAME" mentions are inside the apex warning string.
        const typeCells = Array.from(container.querySelectorAll('table.custom-domain-dns-table tbody td'))
          .map(td => td.textContent ?? '');
        expect(typeCells[0]).not.toBe('CNAME');
        expect(typeCells[0]).toContain('ALIAS');
      } finally {
        cleanup();
      }
    });

    it('renders Type cell as plain CNAME for non-apex (subdomain) attaches', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: 'app.example.com',
          currentDomain: '',
          expectedCnameTarget: 'auto.barney0.manifest0.net',
        },
        description: 'Attach "app.example.com"?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const typeCells = Array.from(container.querySelectorAll('table.custom-domain-dns-table tbody td'))
          .map(td => td.textContent ?? '');
        expect(typeCells[0]).toBe('CNAME');
      } finally {
        cleanup();
      }
    });

    it('renders clear-banner when customDomain is empty', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: '',
          currentDomain: 'old.example.com',
        },
        description: 'Clear custom domain "old.example.com" from "my-api"?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const text = container.textContent ?? '';
        expect(text).toMatch(/clear/i);
        expect(text).toContain('old.example.com');
        expect(text).toContain('my-api');
      } finally {
        cleanup();
      }
    });

    it('does not show CNAME table when clearing', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: '',
          currentDomain: 'old.example.com',
        },
        description: 'Clear?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const text = container.textContent ?? '';
        expect(text).not.toMatch(/registrar/i);
      } finally {
        cleanup();
      }
    });

    it('shows replacement note when changing domain', () => {
      const action = makeAction({
        toolName: 'set_custom_domain',
        args: {
          app_name: 'my-api',
          leaseUuid: 'lu1',
          serviceName: '',
          customDomain: 'new.example.com',
          currentDomain: 'old.example.com',
          expectedCnameTarget: 'auto.barney0.manifest0.net',
        },
        description: 'Replace?',
      });
      const { container, cleanup } = renderInto(action);
      try {
        const text = container.textContent ?? '';
        expect(text).toContain('old.example.com');
        expect(text).toContain('new.example.com');
      } finally {
        cleanup();
      }
    });
  });

  it('displays (ingress) label on ports with ingress flag in read-only stack summary', () => {
    // Use a non-editable tool name so the read-only parseStackManifest path renders
    const manifest = JSON.stringify({
      services: {
        web: { image: 'openclaw', ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} } },
        db: { image: 'postgres:18', ports: { '5432/tcp': {} }, env: { POSTGRES_PASSWORD: 'secret' } },
      },
    });
    const action = makeAction({
      toolName: 'cosmos_tx',
      args: { module: 'billing', subcommand: 'create-lease', _generatedManifest: manifest },
      description: 'Execute transaction?',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => { root.render(createElement(ConfirmationCard, { action, onConfirm: vi.fn(), onCancel: vi.fn() })); });

    try {
      const text = container.textContent ?? '';
      expect(text).toContain('18789/tcp (ingress)');
      expect(text).toContain('8083/tcp');
      expect(text).not.toContain('8083/tcp (ingress)');
      expect(text).toContain('5432/tcp');
      expect(text).not.toContain('5432/tcp (ingress)');
    } finally {
      flushSync(() => { root.unmount(); });
      container.remove();
    }
  });

  describe('deploy_app editable custom domain input', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /** React tracks input value separately; use the prototype setter so onChange fires. */
    function setReactInputValue(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** Advance past the 300ms debounce + flush microtasks so async validation resolves. */
    async function settleAsyncValidation() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
    }

    function renderInto(action: PendingAction, onConfirm = vi.fn()) {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      flushSync(() => { root.render(createElement(ConfirmationCard, { action, onConfirm, onCancel: vi.fn() })); });
      return { container, root, onConfirm, cleanup: () => { flushSync(() => { root.unmount(); }); container.remove(); } };
    }

    function makeDeployAction(args: Record<string, unknown> = {}): PendingAction {
      return {
        originAddress: 'manifest1test',
        chainId: 'manifest-test',
        clientGeneration: 1,
        signerGeneration: 1,
        id: 'deploy-1',
        toolName: 'deploy_app',
        args: { app_name: 'redis', size: 'micro', ...args },
        description: 'Deploy "redis" on micro tier?',
      };
    }

    function findConfirmBtn(container: HTMLElement): HTMLButtonElement {
      return Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Confirm')) as HTMLButtonElement;
    }

    it('renders an empty editable input by default', () => {
      const { container, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('');
        expect(container.textContent ?? '').toMatch(/Custom domain/i);
      } finally { cleanup(); }
    });

    it('pre-fills the input from an AI-prefilled customDomain arg', () => {
      const { container, cleanup } = renderInto(makeDeployAction({ customDomain: 'app.example.com' }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        expect(input.value).toBe('app.example.com');
      } finally { cleanup(); }
    });

    it('disables Confirm while async validation is pending', async () => {
      const { container, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'redis.example.com'));
        // Immediately after typing, async hasn't resolved → button disabled
        expect(findConfirmBtn(container).disabled).toBe(true);
        expect(container.textContent ?? '').toMatch(/Checking domain/i);
        await settleAsyncValidation();
        // After debounce + resolve → button enabled
        expect(findConfirmBtn(container).disabled).toBe(false);
      } finally { cleanup(); }
    });

    it('passes editedCustomDomain to onConfirm after async validation settles', async () => {
      const { container, onConfirm, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'redis.example.com'));
        await settleAsyncValidation();
        flushSync(() => findConfirmBtn(container).click());
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm.mock.calls[0][0].editedCustomDomain).toBe('redis.example.com');
      } finally { cleanup(); }
    });

    it('passes editedCustomDomain="" when user clears a pre-filled domain', async () => {
      const { container, onConfirm, cleanup } = renderInto(makeDeployAction({ customDomain: 'app.example.com' }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, ''));
        // Empty input bypasses async; button immediately enabled
        flushSync(() => findConfirmBtn(container).click());
        expect(onConfirm.mock.calls[0][0].editedCustomDomain).toBe('');
      } finally { cleanup(); }
    });

    it('disables Confirm when domain input has invalid format (IPv4) — sync error', () => {
      const { container, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, '192.168.1.1'));
        // Sync error wins; button disabled without waiting for async
        expect(findConfirmBtn(container).disabled).toBe(true);
        expect(container.textContent ?? '').toMatch(/IP address/i);
      } finally { cleanup(); }
    });

    it('shows apex warning after async validation resolves on a 2-label domain', async () => {
      const { container, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'example.com'));
        await settleAsyncValidation();
        expect(container.textContent ?? '').toMatch(/apex/i);
        // Apex isn't an error — Confirm stays enabled
        expect(findConfirmBtn(container).disabled).toBe(false);
      } finally { cleanup(); }
    });

    it('shows a service select for multi-service stacks when domain is filled', () => {
      const { container, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['web', 'db'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        const select = container.querySelector('select[aria-label="Service to attach domain to"]') as HTMLSelectElement;
        expect(select).not.toBeNull();
        const options = Array.from(select.querySelectorAll('option')).map(o => o.value);
        expect(options).toContain('web');
        expect(options).toContain('db');
      } finally { cleanup(); }
    });

    it('does not show service select for single-service deploys', () => {
      const { container, cleanup } = renderInto(makeDeployAction());
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        const select = container.querySelector('select[aria-label="Service to attach domain to"]');
        expect(select).toBeNull();
      } finally { cleanup(); }
    });

    it('threads selected service name through onConfirm for stacks', async () => {
      const { container, onConfirm, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['web', 'db'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        const select = container.querySelector('select[aria-label="Service to attach domain to"]') as HTMLSelectElement;
        flushSync(() => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
          setter.call(select, 'db');
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settleAsyncValidation();
        flushSync(() => findConfirmBtn(container).click());
        expect(onConfirm.mock.calls[0][0].editedCustomDomainServiceName).toBe('db');
      } finally { cleanup(); }
    });

    // Regression: single-service stacks have no picker (intentional — a
    // 1-option dropdown is just noise), so `handleConfirm` used to clobber
    // the service name to ''. The downstream set-domain TX then went out
    // with service_name='' and got rejected against the named LeaseItem.
    // Both the AI-prefill path and the user-types-it-themselves path need
    // to preserve the lone service name through to onConfirm.
    it('preserves the auto-selected service name for single-service stack deploys', async () => {
      const { container, onConfirm, cleanup } = renderInto(
        makeDeployAction({ _serviceNames: ['wp'], customDomain: 'foo.com', customDomainServiceName: 'wp' })
      );
      try {
        await settleAsyncValidation();
        flushSync(() => findConfirmBtn(container).click());
        expect(onConfirm.mock.calls[0][0].editedCustomDomainServiceName).toBe('wp');
      } finally { cleanup(); }
    });

    it('auto-selects the lone service when user types a domain into a single-service stack', async () => {
      const { container, onConfirm, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['wp'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'foo.com'));
        await settleAsyncValidation();
        flushSync(() => findConfirmBtn(container).click());
        expect(onConfirm.mock.calls[0][0].editedCustomDomainServiceName).toBe('wp');
      } finally { cleanup(); }
    });

    it('disables Confirm when a stack has a domain entered but no service picked', async () => {
      const { container, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['web', 'db'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        await settleAsyncValidation();
        // Picker stays at the default empty option — Confirm should be disabled.
        const select = container.querySelector('select[aria-label="Service to attach domain to"]') as HTMLSelectElement;
        expect(select.value).toBe('');
        expect(findConfirmBtn(container).disabled).toBe(true);
      } finally { cleanup(); }
    });

    it('shows an inline error next to the picker when a stack service is required but unset', async () => {
      const { container, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['web', 'db'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        await settleAsyncValidation();
        expect(container.textContent).toMatch(/pick a service/i);
      } finally { cleanup(); }
    });

    it('re-enables Confirm once the user picks a service', async () => {
      const { container, cleanup } = renderInto(makeDeployAction({ _serviceNames: ['web', 'db'] }));
      try {
        const input = container.querySelector('input[aria-label="Custom domain"]') as HTMLInputElement;
        flushSync(() => setReactInputValue(input, 'app.example.com'));
        await settleAsyncValidation();
        expect(findConfirmBtn(container).disabled).toBe(true);

        const select = container.querySelector('select[aria-label="Service to attach domain to"]') as HTMLSelectElement;
        flushSync(() => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
          setter.call(select, 'web');
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(findConfirmBtn(container).disabled).toBe(false);
      } finally { cleanup(); }
    });
  });
});

// Regression: per-entry domain consent must render from the canonical hashed
// plan; the legacy args.entries batch shape is intentionally not exercised.
describe('ConfirmationCard canonical batch render — per-entry custom-domain', () => {
  it('renders domain + apex warning only for entries that carry them', () => {
    const action = makeDomainBatchAction([
      {
        app_name: 'wp',
        customDomain: 'example.com',
        customDomainServiceName: 'web',
        customDomainWarning: 'Apex CNAMEs are RFC-prohibited; use ALIAS/ANAME/CNAME-flattening at your registrar.',
      },
      { app_name: 'plain' },
    ]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => { act(() => { root.render(createElement(ConfirmationCard, {
      action, onConfirm: vi.fn(), onCancel: vi.fn(),
    })); }); });

    try {
      expect(container.textContent).toMatch(/wp/);
      expect(container.textContent).toMatch(/example\.com/);
      expect(container.textContent).toMatch(/service:.*web/);
      expect(container.textContent).toMatch(/Apex CNAMEs/i);

      expect(container.textContent).toMatch(/plain/);
      // Apex warning must not double-render against the plain entry.
      const warningOccurrences = container.querySelectorAll('.confirmation-apex-warning').length;
      expect(warningOccurrences).toBe(1);
    } finally {
      flushSync(() => { act(() => { root.unmount(); }); });
      container.remove();
    }
  });

  it('renders the service-name annotation only when customDomainServiceName is non-empty', () => {
    const action = makeDomainBatchAction([{
      app_name: 'redis',
      customDomain: 'redis.example.com',
    }]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => { act(() => { root.render(createElement(ConfirmationCard, {
      action, onConfirm: vi.fn(), onCancel: vi.fn(),
    })); }); });

    try {
      expect(container.textContent).toMatch(/redis\.example\.com/);
      expect(container.textContent).not.toMatch(/service:/);
    } finally {
      flushSync(() => { act(() => { root.unmount(); }); });
      container.remove();
    }
  });
});

function makePlannedBatchAction(): PendingAction {
  const alphaManifest = JSON.stringify({
    image: 'alpha:v1',
    ports: { '8080/tcp': { ingress: true } },
    env: { API_TOKEN: 'alpha-secret-value' },
  });
  const betaManifest = JSON.stringify({
    services: {
      web: { image: 'beta-web:v2', ports: { '80/tcp': {} }, env: { SESSION_SECRET: 'beta-secret-value' } },
      db: { image: 'postgres:18', ports: { '5432/tcp': {} }, env: { POSTGRES_PASSWORD: 'db-secret-value' } },
    },
  });
  return makeAction({
    toolName: 'batch_deploy',
    description: 'Deploy 2 apps (alpha, beta) for 0.3000 PWR/hr total?',
    args: {
      plan: {
        version: 1,
        entries: [
          {
            draftIndex: 0,
            app_name: 'alpha',
            size: 'docker-micro',
            skuUuid: 'sku-micro',
            providerUuid: 'provider-1',
            providerUrl: 'https://fred.example.com',
            resources: { cores: 0.5, ramMB: 512, diskGB: 1 },
            manifest: alphaManifest,
            manifestFilename: 'alpha.json',
            manifestSize: alphaManifest.length,
            manifestHash: 'a'.repeat(64),
            services: [{
              name: '', image: 'alpha:v1', ports: ['8080/tcp (ingress)'], environmentKeys: ['API_TOKEN'],
            }],
            serviceNames: [],
            serviceCount: 1,
            pricePerServiceHour: 0.1,
            totalPricePerHour: 0.1,
            denomSymbol: 'PWR',
          },
          {
            draftIndex: 1,
            app_name: 'beta',
            size: 'docker-micro',
            skuUuid: 'sku-micro',
            providerUuid: 'provider-1',
            providerUrl: 'https://fred.example.com',
            resources: { cores: 0.5, ramMB: 512, diskGB: 1 },
            manifest: betaManifest,
            manifestFilename: 'beta.json',
            manifestSize: betaManifest.length,
            manifestHash: 'b'.repeat(64),
            services: [
              { name: 'web', image: 'beta-web:v2', ports: ['80/tcp'], environmentKeys: ['SESSION_SECRET'] },
              { name: 'db', image: 'postgres:18', ports: ['5432/tcp'], environmentKeys: ['POSTGRES_PASSWORD'] },
            ],
            serviceNames: ['web', 'db'],
            serviceCount: 2,
            pricePerServiceHour: 0.1,
            totalPricePerHour: 0.2,
            denomSymbol: 'PWR',
          },
        ],
        totalServiceCount: 3,
        totalPricePerHour: 0.3,
        denomSymbol: 'PWR',
        planHash: 'c'.repeat(64),
      },
    },
  });
}

function makeDomainBatchAction(
  overrides: Array<{
    app_name: string;
    customDomain?: string;
    customDomainServiceName?: string;
    customDomainWarning?: string;
  }>,
): PendingAction {
  const action = makePlannedBatchAction();
  const plan = action.args.plan as {
    entries: Array<Record<string, unknown>>;
    totalServiceCount: number;
    totalPricePerHour: number;
  };
  const template = plan.entries[0];
  return {
    ...action,
    description: `Deploy ${overrides.length} app${overrides.length === 1 ? '' : 's'}?`,
    args: {
      plan: {
        ...plan,
        entries: overrides.map((entry, draftIndex) => ({ ...template, ...entry, draftIndex })),
        totalServiceCount: overrides.length,
        totalPricePerHour: overrides.length * Number(template.totalPricePerHour),
      },
    },
  };
}

const BATCH_EDIT_TIERS: ResolvedSkuTier[] = [
  {
    skuName: 'docker-micro',
    skuUuid: 'sku-micro',
    providerUuid: 'provider-1',
    cores: 0.5,
    ramMB: 512,
    diskGB: 1,
    pricePerHour: 0.1,
    denomSymbol: 'PWR',
    unit: 1,
  },
  {
    skuName: 'docker-small',
    skuUuid: 'sku-small',
    providerUuid: 'provider-1',
    cores: 1,
    ramMB: 1024,
    diskGB: 5,
    pricePerHour: 0.25,
    denomSymbol: 'PWR',
    unit: 1,
  },
];

describe('ConfirmationCard canonical batch plan', () => {
  function renderBatch(
    onConfirm = vi.fn(),
    action: PendingAction = makePlannedBatchAction(),
    isExecuting = false,
  ) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (nextAction = action, nextIsExecuting = isExecuting) => flushSync(() => {
      root.render(createElement(ConfirmationCard, {
        action: nextAction,
        onConfirm,
        onCancel: vi.fn(),
        isExecuting: nextIsExecuting,
      }));
    });
    render();
    return {
      container,
      onConfirm,
      render,
      cleanup: () => {
        flushSync(() => root.unmount());
        container.remove();
      },
    };
  }

  it('renders every app payload detail, redacted environments, hashes, and aggregate rate', () => {
    const { container, cleanup } = renderBatch();
    try {
      const text = container.textContent ?? '';
      expect(text).toContain('alpha:v1');
      expect(text).toContain('beta-web:v2');
      expect(text).toContain('postgres:18');
      expect(text).toContain('8080/tcp (ingress)');
      expect(text).toContain('0.5 vCPU · 512 MB RAM · 1 GB disk');
      expect(text).toContain('API_TOKEN=••••');
      expect(text).toContain('SESSION_SECRET=••••');
      expect(text).not.toContain('alpha-secret-value');
      expect(text).not.toContain('beta-secret-value');
      expect(text).toContain(`Manifest SHA-256: ${'a'.repeat(64)}`);
      expect(text).toContain(`Batch plan SHA-256: ${'c'.repeat(64)}`);
      expect(text).toContain('0.3000 PWR/hr');
      expect(text).toContain('3 services across 2 apps');
    } finally {
      cleanup();
    }
  });

  it('discloses an unavailable requested size recorded by the canonical plan', () => {
    const action = makePlannedBatchAction();
    const plan = action.args.plan as { entries: Array<Record<string, unknown>> };
    plan.entries[0].requestedSize = 'xxlarge';
    const { container, cleanup } = renderBatch(vi.fn(), action);
    try {
      expect(container.textContent).toContain("Requested size ‘xxlarge’ isn’t offered on this network");
      expect(container.textContent).toContain("deploying ‘docker-micro’ (cheapest available) instead");
    } finally {
      cleanup();
    }
  });

  it('recalculates batch pricing and resources when an entry tier changes', () => {
    mockSkuTiers = {
      phase: 'ready',
      tiers: BATCH_EDIT_TIERS,
      denomSymbol: 'PWR',
      error: null,
    };
    const { container, onConfirm, cleanup } = renderBatch();
    try {
      const edit = container.querySelector('button[aria-label="Edit alpha"]') as HTMLButtonElement;
      flushSync(() => edit.click());
      const select = container.querySelector('#batch-tier-alpha') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        'docker-micro',
        'docker-small',
      ]);

      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )!.set!;
        setter.call(select, 'docker-small');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(container.textContent).toContain('alpha · docker-small');
      expect(container.textContent).toContain('0.2500 PWR/hr per service');
      expect(container.textContent).toContain('1 vCPU · 1 GB RAM · 5 GB disk');
      expect(container.textContent).toContain('0.4500 PWR/hr');
      expect(container.textContent).toContain('Batch plan SHA-256: Pending revalidation');
      const review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      flushSync(() => review.click());
      expect(onConfirm).toHaveBeenCalledWith({
        editedBatchEntries: expect.arrayContaining([
          expect.objectContaining({ app_name: 'alpha', size: 'docker-small' }),
        ]),
      });
    } finally {
      cleanup();
    }
  });

  it('falls back when an edited tier disappears and explains an unavailable catalog', () => {
    mockSkuTiers = {
      phase: 'ready',
      tiers: BATCH_EDIT_TIERS,
      denomSymbol: 'PWR',
      error: null,
    };
    const action = makePlannedBatchAction();
    const { container, render, cleanup } = renderBatch(vi.fn(), action);
    try {
      const edit = container.querySelector('button[aria-label="Edit alpha"]') as HTMLButtonElement;
      flushSync(() => edit.click());
      const select = container.querySelector('#batch-tier-alpha') as HTMLSelectElement;
      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )!.set!;
        setter.call(select, 'docker-small');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      mockSkuTiers = {
        phase: 'ready',
        tiers: [BATCH_EDIT_TIERS[0]],
        denomSymbol: 'PWR',
        error: null,
      };
      render({ ...action, args: { ...action.args } });
      expect(container.textContent).toContain("Requested size ‘docker-small’ isn’t offered");
      expect(container.textContent).toContain("deploying ‘docker-micro’ (cheapest available) instead");
      let review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      expect(review.disabled).toBe(false);

      mockSkuTiers = { phase: 'ready', tiers: [], denomSymbol: 'PWR', error: null };
      render({ ...action, args: { ...action.args } });

      expect(container.textContent).toContain('Resource tiers are currently unavailable');
      expect(container.querySelector('[data-testid="batch-deploy-total"]')?.textContent)
        .toContain('Pending revalidation');
      review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      expect(review.disabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('removes an entry without retaining its stale aggregate total and requests a new plan', () => {
    const { container, onConfirm, cleanup } = renderBatch();
    try {
      const remove = container.querySelector('button[aria-label="Remove beta"]') as HTMLButtonElement;
      flushSync(() => remove.click());

      const text = container.textContent ?? '';
      expect(text).toContain('0.1000 PWR/hr');
      expect(text).toContain('1 service across 1 app');
      expect(text).toContain('Batch plan SHA-256: Pending revalidation');
      const review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      flushSync(() => review.click());
      expect(onConfirm).toHaveBeenCalledWith({
        editedBatchEntries: [expect.objectContaining({ app_name: 'alpha' })],
      });
    } finally {
      cleanup();
    }
  });

  it('preserves an edited entry across a parent render and editor close/reopen', () => {
    const action = makePlannedBatchAction();
    const { container, onConfirm, render, cleanup } = renderBatch(vi.fn(), action);
    try {
      const edit = container.querySelector('button[aria-label="Edit alpha"]') as HTMLButtonElement;
      flushSync(() => edit.click());
      const removePort = container.querySelector('button[aria-label="Remove port 8080/tcp"]') as HTMLButtonElement;
      flushSync(() => removePort.click());

      expect(container.textContent).toContain('Manifest SHA-256: Pending revalidation');
      // A failed re-plan replaces action args while preserving the card id.
      // Parsed editor state must survive that parent render without re-parsing
      // the original manifest back over the local edit.
      render({
        ...action,
        args: { ...action.args, _batchReplanError: 'temporary planner failure' },
      });
      const finishEdit = container.querySelector(
        'button[aria-label="Finish editing alpha"]',
      ) as HTMLButtonElement;
      flushSync(() => finishEdit.click());
      const reopenEdit = container.querySelector(
        'button[aria-label="Edit alpha"]',
      ) as HTMLButtonElement;
      flushSync(() => reopenEdit.click());

      expect(container.querySelector('#batch-tier-alpha')).not.toBeNull();
      expect(container.querySelector('button[aria-label="Remove port 8080/tcp"]')).toBeNull();
      expect(container.textContent).toContain('Manifest SHA-256: Pending revalidation');
      const review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      flushSync(() => review.click());

      const override = onConfirm.mock.calls[0][0];
      expect(override.editedBatchEntries).toHaveLength(2);
      const alpha = override.editedBatchEntries.find((entry: { app_name: string }) => entry.app_name === 'alpha');
      expect(JSON.parse(alpha.manifest).ports).toBeUndefined();
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('returns to the approved plan when a newly entered domain is cleared', () => {
    const { container, onConfirm, cleanup } = renderBatch();
    try {
      const edit = container.querySelector('button[aria-label="Edit alpha"]') as HTMLButtonElement;
      flushSync(() => edit.click());
      const input = container.querySelector(
        'input[aria-label="Custom domain for alpha"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;

      flushSync(() => {
        setter.call(input, 'alpha.example.com');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.textContent).toContain('Batch plan SHA-256: Pending revalidation');

      flushSync(() => {
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.textContent).toContain(`Batch plan SHA-256: ${'c'.repeat(64)}`);
      const confirm = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Confirm') as HTMLButtonElement;
      flushSync(() => confirm.click());

      expect(onConfirm).toHaveBeenCalledWith(undefined);
    } finally {
      cleanup();
    }
  });

  it('restores approved domain metadata when the original domain is re-entered', () => {
    const action = makePlannedBatchAction();
    const plan = action.args.plan as {
      entries: Array<Record<string, unknown>>;
      totalServiceCount: number;
      totalPricePerHour: number;
    };
    plan.entries = [{
      ...plan.entries[1],
      customDomain: 'beta.example.com',
      customDomainServiceName: 'web',
      customDomainWarning: 'Original domain warning',
    }];
    plan.totalServiceCount = 2;
    plan.totalPricePerHour = 0.2;
    const { container, onConfirm, cleanup } = renderBatch(vi.fn(), action);
    try {
      const edit = container.querySelector('button[aria-label="Edit beta"]') as HTMLButtonElement;
      flushSync(() => edit.click());
      const input = container.querySelector(
        'input[aria-label="Custom domain for beta"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;

      flushSync(() => {
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      flushSync(() => {
        setter.call(input, 'beta.example.com');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const service = container.querySelector(
        'select[aria-label="Service for beta custom domain"]',
      ) as HTMLSelectElement;
      expect(service.value).toBe('web');
      expect(container.textContent).toContain(`Batch plan SHA-256: ${'c'.repeat(64)}`);
      const confirm = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Confirm') as HTMLButtonElement;
      flushSync(() => confirm.click());
      expect(onConfirm).toHaveBeenCalledWith(undefined);
    } finally {
      cleanup();
    }
  });

  it('lets a one-entry batch survivor edit its custom domain and stack service', () => {
    const action = makePlannedBatchAction();
    const plan = action.args.plan as {
      entries: Array<Record<string, unknown>>;
      totalServiceCount: number;
      totalPricePerHour: number;
    };
    plan.entries = [plan.entries[1]];
    plan.totalServiceCount = 2;
    plan.totalPricePerHour = 0.2;
    const { container, onConfirm, cleanup } = renderBatch(vi.fn(), action);
    try {
      const edit = container.querySelector('button[aria-label="Edit beta"]') as HTMLButtonElement;
      flushSync(() => edit.click());

      const input = container.querySelector('input[aria-label="Custom domain for beta"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'beta.example.com');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const select = container.querySelector(
        'select[aria-label="Service for beta custom domain"]',
      ) as HTMLSelectElement;
      expect(select).not.toBeNull();
      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(select, 'web');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const review = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Review updated plan')) as HTMLButtonElement;
      flushSync(() => review.click());

      expect(onConfirm).toHaveBeenCalledWith({
        editedBatchEntries: [expect.objectContaining({
          draftIndex: 1,
          app_name: 'beta',
          customDomain: 'beta.example.com',
          customDomainServiceName: 'web',
        })],
      });
    } finally {
      cleanup();
    }
  });

  it('disables confirmation when a plan entry has no services', () => {
    const action = makePlannedBatchAction();
    const plan = action.args.plan as {
      entries: Array<Record<string, unknown>>;
      totalServiceCount: number;
      totalPricePerHour: number;
    };
    plan.entries = [{
      ...plan.entries[0],
      services: [],
      serviceNames: [],
      serviceCount: 0,
      totalPricePerHour: 0,
    }];
    plan.totalServiceCount = 0;
    plan.totalPricePerHour = 0;
    const { container, cleanup } = renderBatch(vi.fn(), action);
    try {
      expect(container.querySelector('[data-testid="batch-deploy-total"]')?.textContent)
        .toContain('Pending revalidation');
      const confirm = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Confirm')) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('preserves local drafts across a failed re-plan and labels revalidation accurately', () => {
    const action = makePlannedBatchAction();
    const { container, render, cleanup } = renderBatch(vi.fn(), action);
    try {
      const remove = container.querySelector('button[aria-label="Remove beta"]') as HTMLButtonElement;
      flushSync(() => remove.click());

      render(action, true);
      expect(container.textContent).toContain('Revalidating...');

      render({
        ...action,
        args: {
          ...action.args,
          _batchReplanError: 'Tier catalog unavailable',
        },
      }, false);
      expect(container.textContent).toContain('Could not rebuild the batch plan: Tier catalog unavailable');
      expect(container.textContent).toContain('Your edits are still here');
      expect(container.textContent).not.toContain('beta-web:v2');
      expect(container.textContent).toContain('1 service across 1 app');
    } finally {
      cleanup();
    }
  });
});
