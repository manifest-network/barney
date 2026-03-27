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
        editable: { image: 'node:20', ports: { '3000/tcp': {} }, env: {} },
        passthrough: {},
      },
    };
    const element = createElement(StackManifestEditor, { stack, onChange });
    expect(element).toBeDefined();
    expect(Object.keys(element.props.stack)).toHaveLength(1);
  });
});

describe('parseEditableStackManifest', () => {
  function makeAction(json: string) {
    return { id: '1', toolName: 'deploy_app', args: { _generatedManifest: json }, description: '' };
  }

  it('keeps all env vars including JSON blobs per service', () => {
    const json = JSON.stringify({
      services: {
        app: { image: 'app:1', env: { KEY: 'val', MODELS: '{"a":1}' } },
        db: { image: 'pg:16', env: { PASSWORD: 'secret' } },
      },
    });
    const result = parseEditableStackManifest(makeAction(json));
    expect(result?.app.editable.env).toEqual({ KEY: 'val', MODELS: '{"a":1}' });
    expect(result?.db.editable.env).toEqual({ PASSWORD: 'secret' });
  });
});

describe('serializeStackManifest', () => {
  it('preserves all env vars in serialized output', () => {
    const stack: StackManifestFields = {
      app: {
        editable: {
          image: 'app:1', ports: {}, env: { KEY: 'val', MODELS: '{"a":1}' },
        },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.app.env).toEqual({ KEY: 'val', MODELS: '{"a":1}' });
  });

  it('preserves ingress flag in port values per service', () => {
    const stack: StackManifestFields = {
      web: {
        editable: {
          image: 'openclaw', ports: { '18789/tcp': { ingress: true }, '8083/tcp': {} }, env: {},
        },
        passthrough: {},
      },
    };
    const parsed = JSON.parse(serializeStackManifest(stack));
    expect(parsed.services.web.ports['18789/tcp']).toEqual({ ingress: true });
    expect(parsed.services.web.ports['8083/tcp']).toEqual({});
  });
});
