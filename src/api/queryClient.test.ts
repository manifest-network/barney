import { describe, it, expect } from 'vitest';
import { fixEnumField, queryWithNotFound } from './queryClient';

describe('fixEnumField', () => {
  it('applies converter to target field and returns new object', () => {
    const obj = { state: 'LEASE_STATE_ACTIVE', uuid: '123' };
    const result = fixEnumField(obj, 'state', () => 1 as unknown as string);
    expect(result.state).toBe(1);
  });

  it('does not mutate the original object', () => {
    const obj = { state: 'LEASE_STATE_ACTIVE', uuid: '123' };
    fixEnumField(obj, 'state', () => 1 as unknown as string);
    expect(obj.state).toBe('LEASE_STATE_ACTIVE');
  });

  it('preserves all other fields unchanged', () => {
    const obj = { state: 'PENDING', name: 'test', count: 42 };
    const result = fixEnumField(obj, 'state', () => 1 as unknown as string);
    expect(result.name).toBe('test');
    expect(result.count).toBe(42);
  });

  it('works with numeric enum conversion', () => {
    const converter = (val: string) => ({ A: 0, B: 1 })[val] as unknown as string ?? -1 as unknown as string;
    const obj = { type: 'B', label: 'hello' };
    const result = fixEnumField(obj, 'type', converter);
    expect(result.type).toBe(1);
    expect(result.label).toBe('hello');
  });
});

describe('queryWithNotFound', () => {
  it('returns query result on success', async () => {
    const result = await queryWithNotFound(() => Promise.resolve({ data: 'ok' }), null);
    expect(result).toEqual({ data: 'ok' });
  });

  it('returns provided default on 404 error', async () => {
    const error404 = { response: { status: 404 } };
    const result = await queryWithNotFound(() => Promise.reject(error404), 'default-value');
    expect(result).toBe('default-value');
  });

  it('returns default with null default on 404', async () => {
    const error404 = { response: { status: 404 } };
    const result = await queryWithNotFound(() => Promise.reject(error404), null);
    expect(result).toBeNull();
  });

  it('re-throws non-404 errors (500)', async () => {
    const error500 = { response: { status: 500 } };
    await expect(queryWithNotFound(() => Promise.reject(error500), null)).rejects.toBe(error500);
  });

  it('re-throws network errors (no response property)', async () => {
    const networkError = new Error('Network failure');
    await expect(queryWithNotFound(() => Promise.reject(networkError), null)).rejects.toThrow(
      'Network failure'
    );
  });

  it('re-throws plain Error objects', async () => {
    const error = new Error('Something went wrong');
    await expect(queryWithNotFound(() => Promise.reject(error), 'default')).rejects.toThrow(
      'Something went wrong'
    );
  });
});
