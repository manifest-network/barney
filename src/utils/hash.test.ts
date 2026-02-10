import { describe, it, expect } from 'vitest';
import {
  sha256,
  sha256Hex,
  toHex,
  validatePayloadSize,
  getPayloadSize,
  generatePassword,
  MAX_PAYLOAD_SIZE,
} from './hash';

describe('sha256', () => {
  it('hashes a string correctly', async () => {
    const hash = await sha256('hello');
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32); // SHA-256 produces 32 bytes

    // Known SHA-256 hash of "hello"
    const expectedHex = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(toHex(hash)).toBe(expectedHex);
  });

  it('hashes a Uint8Array correctly', async () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]); // "hello" as bytes
    const hash = await sha256(input);
    expect(hash.length).toBe(32);

    const expectedHex = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(toHex(hash)).toBe(expectedHex);
  });

  it('handles ArrayBuffer views correctly', async () => {
    // Create a larger buffer and a view into part of it
    const fullBuffer = new ArrayBuffer(20);
    const fullView = new Uint8Array(fullBuffer);
    fullView.set([0, 0, 0, 104, 101, 108, 108, 111, 0, 0], 0);

    // Create a view that only covers "hello" (bytes 3-7)
    const partialView = new Uint8Array(fullBuffer, 3, 5);

    const hash = await sha256(partialView);
    const expectedHex = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(toHex(hash)).toBe(expectedHex);
  });

  it('handles empty input', async () => {
    const hash = await sha256('');
    // Known SHA-256 hash of empty string
    const expectedHex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(toHex(hash)).toBe(expectedHex);
  });
});

describe('sha256Hex', () => {
  it('returns hash as hex string', async () => {
    const hash = await sha256Hex('hello');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // 32 bytes * 2 hex chars
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('toHex', () => {
  it('converts bytes to hex string', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(toHex(bytes)).toBe('00010f10ff');
  });

  it('handles empty array', () => {
    expect(toHex(new Uint8Array([]))).toBe('');
  });
});

describe('validatePayloadSize', () => {
  it('returns true for valid size', () => {
    expect(validatePayloadSize('hello')).toBe(true);
    expect(validatePayloadSize(new Uint8Array(1000))).toBe(true);
  });

  it('returns true for exactly max size', () => {
    const payload = 'x'.repeat(MAX_PAYLOAD_SIZE);
    expect(validatePayloadSize(payload)).toBe(true);
  });

  it('returns false for oversized payload', () => {
    const payload = 'x'.repeat(MAX_PAYLOAD_SIZE + 1);
    expect(validatePayloadSize(payload)).toBe(false);
  });
});

describe('getPayloadSize', () => {
  it('returns correct size for string', () => {
    expect(getPayloadSize('hello')).toBe(5);
  });

  it('returns correct size for Uint8Array', () => {
    expect(getPayloadSize(new Uint8Array(100))).toBe(100);
  });

  it('handles UTF-8 encoding', () => {
    // "é" is 2 bytes in UTF-8
    expect(getPayloadSize('é')).toBe(2);
  });
});

describe('generatePassword', () => {
  it('returns default length of 16', () => {
    expect(generatePassword()).toHaveLength(16);
  });

  it('respects custom length', () => {
    expect(generatePassword(8)).toHaveLength(8);
    expect(generatePassword(32)).toHaveLength(32);
  });

  it('contains only alphanumeric characters', () => {
    const password = generatePassword(100);
    expect(password).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('generates unique values across calls', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBe(20);
  });
});
