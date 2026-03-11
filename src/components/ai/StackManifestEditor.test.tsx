import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { StackManifestEditor } from './StackManifestEditor';
import {
  parseEditableStackManifest,
  serializeStackManifest,
  type StackManifestFields,
} from './manifestEditorUtils';

function makeStack(): StackManifestFields {
  return {
    wordpress: {
      editable: {
        image: 'wordpress:latest',
        ports: { '80/tcp': {} as Record<string, never> },
        env: { WORDPRESS_DB_HOST: 'mysql' },
      },
      passthrough: { depends_on: ['mysql'] },
    },
    mysql: {
      editable: {
        image: 'mysql:8',
        ports: {},
        env: { MYSQL_ROOT_PASSWORD: 'secret' },
      },
      passthrough: {},
    },
  };
}

describe('StackManifestEditor', () => {
  it('can be instantiated with stack data', () => {
    const onChange = vi.fn();
    const element = createElement(StackManifestEditor, { stack: makeStack(), onChange });
    expect(element).toBeDefined();
    expect(element.type).toBe(StackManifestEditor);
    expect(element.props.stack).toBeDefined();
    expect(Object.keys(element.props.stack)).toEqual(['wordpress', 'mysql']);
  });

  it('renders correct number of service sections', () => {
    const onChange = vi.fn();
    const stack = makeStack();
    const element = createElement(StackManifestEditor, { stack, onChange });
    expect(Object.keys(element.props.stack)).toHaveLength(2);
  });

  it('accepts single-service stacks', () => {
    const onChange = vi.fn();
    const stack: StackManifestFields = {
      app: {
        editable: { image: 'node:20', ports: { '3000/tcp': {} as Record<string, never> }, env: {} },
        passthrough: {},
      },
    };
    const element = createElement(StackManifestEditor, { stack, onChange });
    expect(element).toBeDefined();
    expect(Object.keys(element.props.stack)).toHaveLength(1);
  });
});

describe('parseEditableStackManifest (hiddenEnv)', () => {
  function makeAction(json: string) {
    return { id: '1', toolName: 'deploy_app', args: { _generatedManifest: json }, description: '' };
  }

  it('splits JSON blob env vars into hiddenEnv per service', () => {
    const json = JSON.stringify({
      services: {
        app: { image: 'app:1', env: { KEY: 'val', MODELS: '{"a":1}' } },
        db: { image: 'pg:16', env: { PASSWORD: 'secret' } },
      },
    });
    const result = parseEditableStackManifest(makeAction(json));
    expect(result?.app.editable.env).toEqual({ KEY: 'val' });
    expect(result?.app.editable.hiddenEnv).toEqual({ MODELS: '{"a":1}' });
    expect(result?.db.editable.env).toEqual({ PASSWORD: 'secret' });
    expect(result?.db.editable.hiddenEnv).toBeUndefined();
  });
});

describe('serializeStackManifest (hiddenEnv)', () => {
  it('merges hiddenEnv back into service env', () => {
    const stack: StackManifestFields = {
      app: {
        editable: {
          image: 'app:1', ports: {}, env: { KEY: 'val' },
          hiddenEnv: { MODELS: '{"a":1}' },
        },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.app.env).toEqual({ MODELS: '{"a":1}', KEY: 'val' });
  });

  it('user env overrides hiddenEnv on collision', () => {
    const stack: StackManifestFields = {
      app: {
        editable: {
          image: 'app:1', ports: {}, env: { MODELS: 'override' },
          hiddenEnv: { MODELS: '{"old":true}' },
        },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.app.env.MODELS).toBe('override');
  });
});
