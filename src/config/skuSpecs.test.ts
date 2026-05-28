import { describe, it, expect, vi } from 'vitest';
import { parseSkuSpecs } from './skuSpecs';

describe('parseSkuSpecs', () => {
  it('parses valid JSON spec map', () => {
    const raw = '{"docker-micro":{"cores":0.5,"ramMB":512,"diskGB":1}}';
    expect(parseSkuSpecs(raw)).toEqual({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
    });
  });

  it('returns empty map for empty string', () => {
    expect(parseSkuSpecs('')).toEqual({});
  });

  it('returns empty map for whitespace-only string', () => {
    expect(parseSkuSpecs('   \n\t')).toEqual({});
  });

  it('returns empty map and logs error for invalid JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseSkuSpecs('{not json')).toEqual({});
    spy.mockRestore();
  });

  it('drops entries with missing required fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = '{"docker-x":{"cores":1,"ramMB":1024}}';
    expect(parseSkuSpecs(raw)).toEqual({});
    spy.mockRestore();
  });

  it('drops entries with non-number fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = '{"docker-x":{"cores":"1","ramMB":1024,"diskGB":5}}';
    expect(parseSkuSpecs(raw)).toEqual({});
    spy.mockRestore();
  });

  it('drops entries with negative numbers', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = '{"docker-x":{"cores":-1,"ramMB":1024,"diskGB":5}}';
    expect(parseSkuSpecs(raw)).toEqual({});
    spy.mockRestore();
  });

  it('rejects non-object top-level JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseSkuSpecs('[1,2,3]')).toEqual({});
    expect(parseSkuSpecs('"string"')).toEqual({});
    expect(parseSkuSpecs('null')).toEqual({});
    spy.mockRestore();
  });

  it('handles multi-SKU map', () => {
    const raw = JSON.stringify({
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-small': { cores: 1, ramMB: 1024, diskGB: 5 },
    });
    expect(Object.keys(parseSkuSpecs(raw))).toEqual(['docker-micro', 'docker-small']);
  });

  it('preserves insertion order of keys', () => {
    const raw = JSON.stringify({
      'docker-large': { cores: 4, ramMB: 4096, diskGB: 20 },
      'docker-micro': { cores: 0.5, ramMB: 512, diskGB: 1 },
      'docker-medium': { cores: 2, ramMB: 2048, diskGB: 10 },
    });
    expect(Object.keys(parseSkuSpecs(raw))).toEqual(['docker-large', 'docker-micro', 'docker-medium']);
  });
});
