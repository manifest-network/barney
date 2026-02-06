import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { LogCard } from './LogCard';

describe('LogCard', () => {
  it('can be instantiated with valid props', () => {
    const element = createElement(LogCard, {
      appName: 'test-app',
      logs: { web: 'hello world' },
      truncated: false,
    });
    expect(element).toBeDefined();
    expect(element.type).toBe(LogCard);
    expect(element.props.appName).toBe('test-app');
    expect(element.props.logs).toEqual({ web: 'hello world' });
    expect(element.props.truncated).toBe(false);
  });

  it('accepts empty logs', () => {
    const element = createElement(LogCard, {
      appName: 'test-app',
      logs: {},
      truncated: false,
    });
    expect(element).toBeDefined();
    expect(element.props.logs).toEqual({});
  });

  it('accepts multiple services', () => {
    const element = createElement(LogCard, {
      appName: 'test-app',
      logs: { web: 'web logs', worker: 'worker logs' },
      truncated: true,
    });
    expect(element).toBeDefined();
    expect(Object.keys(element.props.logs)).toHaveLength(2);
    expect(element.props.truncated).toBe(true);
  });
});
