import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJson, buildUrl, buildPaginationParams } from './utils';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('fetchJson', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON for successful response', async () => {
    const mockData = { foo: 'bar' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const result = await fetchJson<typeof mockData>('/test', 'test resource');
    expect(result).toEqual(mockData);
  });

  it('throws error for non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(fetchJson('/test', 'test resource')).rejects.toThrow(
      'Failed to fetch test resource: Internal Server Error'
    );
  });

  it('returns notFoundDefault for 404 response when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await fetchJson<string[]>('/test', 'test resource', {
      notFoundDefault: [],
    });
    expect(result).toEqual([]);
  });

  it('throws error for 404 response when notFoundDefault not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(fetchJson('/test', 'test resource')).rejects.toThrow(
      'Failed to fetch test resource: Not Found'
    );
  });

  it('prepends REST_URL for relative URLs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchJson('/api/test', 'test');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost:\d+\/api\/test$/)
    );
  });

  it('uses absolute URLs directly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchJson('https://example.com/api', 'test');

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/api');
  });

  it('allows null as notFoundDefault', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await fetchJson<{ data: string } | null>('/test', 'test', {
      notFoundDefault: null,
    });
    expect(result).toBeNull();
  });
});

describe('buildUrl', () => {
  it('returns base path with REST_URL when no params', () => {
    const url = buildUrl('/api/test');
    expect(url).toMatch(/^http:\/\/localhost:\d+\/api\/test$/);
  });

  it('appends query parameters', () => {
    const url = buildUrl('/api/test', { foo: 'bar', baz: 'qux' });
    expect(url).toMatch(/\?foo=bar&baz=qux$/);
  });

  it('ignores undefined values', () => {
    const url = buildUrl('/api/test', { foo: 'bar', baz: undefined });
    expect(url).toMatch(/\?foo=bar$/);
    expect(url).not.toContain('baz');
  });

  it('encodes special characters in values', () => {
    const url = buildUrl('/api/test', { query: 'hello world' });
    expect(url).toContain('query=hello+world');
  });

  it('handles empty params object', () => {
    const url = buildUrl('/api/test', {});
    expect(url).not.toContain('?');
  });

  it('handles all undefined params', () => {
    const url = buildUrl('/api/test', { a: undefined, b: undefined });
    expect(url).not.toContain('?');
  });
});

describe('buildPaginationParams', () => {
  it('returns empty object when no options', () => {
    expect(buildPaginationParams()).toEqual({});
  });

  it('returns empty object for undefined options', () => {
    expect(buildPaginationParams(undefined)).toEqual({});
  });

  it('includes limit when provided', () => {
    const params = buildPaginationParams({ limit: 10 });
    expect(params['pagination.limit']).toBe('10');
  });

  it('includes offset when provided', () => {
    const params = buildPaginationParams({ offset: 20 });
    expect(params['pagination.offset']).toBe('20');
  });

  it('includes pagination key when provided', () => {
    const params = buildPaginationParams({ paginationKey: 'abc123' });
    expect(params['pagination.key']).toBe('abc123');
  });

  it('includes count_total when countTotal is true', () => {
    const params = buildPaginationParams({ countTotal: true });
    expect(params['pagination.count_total']).toBe('true');
  });

  it('excludes count_total when countTotal is false', () => {
    const params = buildPaginationParams({ countTotal: false });
    expect(params['pagination.count_total']).toBeUndefined();
  });

  it('handles all options together', () => {
    const params = buildPaginationParams({
      limit: 10,
      offset: 20,
      paginationKey: 'key123',
      countTotal: true,
    });

    expect(params).toEqual({
      'pagination.limit': '10',
      'pagination.offset': '20',
      'pagination.key': 'key123',
      'pagination.count_total': 'true',
    });
  });

  it('omits undefined values', () => {
    const params = buildPaginationParams({ limit: 10 });
    expect(params['pagination.offset']).toBeUndefined();
    expect(params['pagination.key']).toBeUndefined();
  });
});
