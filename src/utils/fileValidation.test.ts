import { describe, it, expect } from 'vitest';
import {
  validateFile,
  ALLOWED_FILE_TYPES,
  ALLOWED_FILE_EXTENSIONS,
} from './fileValidation';
import { MAX_PAYLOAD_SIZE } from './hash';
import { MAX_FILENAME_LENGTH } from '../config/constants';

// Helper to create a mock File object
function createMockFile(
  name: string,
  size: number,
  type: string = 'text/plain'
): File {
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

describe('validateFile', () => {
  describe('empty file validation', () => {
    it('rejects empty files', () => {
      const file = createMockFile('test.yaml', 0, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty');
    });
  });

  describe('file size validation', () => {
    it('accepts files within size limit', () => {
      const file = createMockFile('test.yaml', 1024, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('rejects files exceeding size limit', () => {
      const file = createMockFile('test.yaml', MAX_PAYLOAD_SIZE + 1, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum size');
    });

    it('accepts files at exactly the size limit', () => {
      const file = createMockFile('test.yaml', MAX_PAYLOAD_SIZE, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });
  });

  describe('filename length validation', () => {
    it('accepts normal filenames', () => {
      const file = createMockFile('deployment.yaml', 100, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('rejects filenames exceeding max length', () => {
      const longName = 'a'.repeat(MAX_FILENAME_LENGTH + 1) + '.yaml';
      const file = createMockFile(longName, 100, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Filename is too long');
    });
  });

  describe('file extension validation', () => {
    it('accepts .yaml extension', () => {
      const file = createMockFile('config.yaml', 100, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('accepts .yml extension', () => {
      const file = createMockFile('config.yml', 100, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('accepts .json extension', () => {
      const file = createMockFile('config.json', 100, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('accepts .txt extension', () => {
      const file = createMockFile('readme.txt', 100, 'text/plain');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('rejects disallowed extensions', () => {
      const file = createMockFile('script.js', 100, 'application/javascript');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('extension ".js" is not allowed');
    });

    it('rejects files without extension', () => {
      const file = createMockFile('noextension', 100, 'text/plain');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('(none)');
    });

    it('handles uppercase extensions (case insensitive)', () => {
      const file = createMockFile('config.YAML', 100, 'text/yaml');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });
  });

  describe('MIME type validation', () => {
    it('accepts allowed MIME types', () => {
      for (const mimeType of ALLOWED_FILE_TYPES) {
        const ext = mimeType.includes('yaml') ? '.yaml' : mimeType.includes('json') ? '.json' : '.txt';
        const file = createMockFile(`test${ext}`, 100, mimeType);
        const result = validateFile(file);
        expect(result.valid).toBe(true);
      }
    });

    it('rejects disallowed MIME types', () => {
      const file = createMockFile('test.yaml', 100, 'application/octet-stream');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('File type');
    });

    it('accepts files with no MIME type (relies on extension)', () => {
      // Some browsers don't set MIME type - extension should still be validated
      const file = createMockFile('test.yaml', 100, '');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });
  });
});

describe('ALLOWED_FILE_TYPES', () => {
  it('includes text/plain', () => {
    expect(ALLOWED_FILE_TYPES).toContain('text/plain');
  });

  it('includes YAML types', () => {
    expect(ALLOWED_FILE_TYPES).toContain('text/yaml');
    expect(ALLOWED_FILE_TYPES).toContain('text/x-yaml');
    expect(ALLOWED_FILE_TYPES).toContain('application/x-yaml');
  });

  it('includes application/json', () => {
    expect(ALLOWED_FILE_TYPES).toContain('application/json');
  });
});

describe('ALLOWED_FILE_EXTENSIONS', () => {
  it('includes expected extensions', () => {
    expect(ALLOWED_FILE_EXTENSIONS).toContain('.yaml');
    expect(ALLOWED_FILE_EXTENSIONS).toContain('.yml');
    expect(ALLOWED_FILE_EXTENSIONS).toContain('.json');
    expect(ALLOWED_FILE_EXTENSIONS).toContain('.txt');
  });
});
