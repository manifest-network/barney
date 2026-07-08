import { describe, it, expect } from 'vitest';
import {
  validateFile,
  validateManifestContent,
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
      const file = createMockFile('test.json', 0, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty');
    });
  });

  describe('file size validation', () => {
    it('accepts files within size limit', () => {
      const file = createMockFile('test.json', 1024, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('rejects files exceeding size limit', () => {
      const file = createMockFile('test.json', MAX_PAYLOAD_SIZE + 1, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum size');
    });

    it('accepts files at exactly the size limit', () => {
      const file = createMockFile('test.json', MAX_PAYLOAD_SIZE, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });
  });

  describe('filename length validation', () => {
    it('accepts normal filenames', () => {
      const file = createMockFile('deployment.json', 100, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('rejects filenames exceeding max length', () => {
      const longName = 'a'.repeat(MAX_FILENAME_LENGTH + 1) + '.json';
      const file = createMockFile(longName, 100, 'application/json');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Filename is too long');
    });
  });

  describe('file extension validation', () => {
    it('rejects .yaml extension (SDK is JSON-only)', () => {
      const file = createMockFile('config.yaml', 100, '');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('extension ".yaml" is not allowed');
    });

    it('rejects .yml extension (SDK is JSON-only)', () => {
      const file = createMockFile('config.yml', 100, '');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('extension ".yml" is not allowed');
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
      const file = createMockFile('config.JSON', 100, 'application/json');
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
      const file = createMockFile('test.json', 100, 'application/octet-stream');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('File type');
    });

    it('accepts files with no MIME type (relies on extension)', () => {
      // Some browsers don't set MIME type - extension should still be validated
      const file = createMockFile('test.json', 100, '');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });
  });
});

describe('ALLOWED_FILE_TYPES', () => {
  it('contains only plain-text and JSON MIME types', () => {
    expect(ALLOWED_FILE_TYPES).toEqual(['text/plain', 'application/json']);
  });
});

describe('ALLOWED_FILE_EXTENSIONS', () => {
  it('contains only .json and .txt', () => {
    expect(ALLOWED_FILE_EXTENSIONS).toEqual(['.json', '.txt']);
  });
});

const encode = (text: string) => new TextEncoder().encode(text);

describe('validateManifestContent', () => {
  describe('JSON manifests', () => {
    it('accepts valid single-service manifest', () => {
      const bytes = encode(JSON.stringify({ image: 'redis:8', ports: { '6379/tcp': {} } }));
      expect(validateManifestContent(bytes)).toEqual({ valid: true });
    });

    it('accepts valid stack manifest', () => {
      const bytes = encode(JSON.stringify({
        services: {
          web: { image: 'wordpress:6', ports: { '80/tcp': {} } },
          db: { image: 'mysql:9' },
        },
      }));
      expect(validateManifestContent(bytes)).toEqual({ valid: true });
    });

    it('rejects invalid JSON syntax', () => {
      const bytes = encode('{ image: "redis" }');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('rejects JSON array', () => {
      const bytes = encode('[1, 2, 3]');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Manifest must be a JSON object');
    });

    it('rejects JSON without image or services', () => {
      const bytes = encode(JSON.stringify({ ports: { '80/tcp': {} } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing a valid "image" field');
    });

    it('rejects stack with empty services', () => {
      const bytes = encode(JSON.stringify({ services: {} }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least one service');
    });

    it('rejects stack service missing image', () => {
      const bytes = encode(JSON.stringify({ services: { web: { ports: {} } } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Service "web" is missing a valid "image"');
    });

    it('rejects services as array', () => {
      const bytes = encode(JSON.stringify({ services: [{ image: 'redis' }] }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('"services" must be an object');
    });

    it('rejects service config as non-object', () => {
      const bytes = encode(JSON.stringify({ services: { web: 'wordpress' } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Service "web" must be an object');
    });

    it('rejects uppercase service name', () => {
      const bytes = encode(JSON.stringify({ services: { MyDB: { image: 'mysql:9' } } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "MyDB"');
    });

    it('rejects service name with underscores', () => {
      const bytes = encode(JSON.stringify({ services: { my_db: { image: 'mysql:9' } } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "my_db"');
    });

    it('rejects service name with colon', () => {
      const bytes = encode(JSON.stringify({ services: { 'web:server': { image: 'nginx:1' } } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "web:server"');
    });

    it('rejects service name starting with hyphen', () => {
      const bytes = encode(JSON.stringify({ services: { '-web': { image: 'nginx:1' } } }));
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "-web"');
    });
  });

  describe('non-JSON content (rejected — deploy path is JSON-only, §3.9)', () => {
    it('rejects a YAML single-service manifest', () => {
      const bytes = encode('image: nginx:1\nports:\n  80/tcp: {}');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('rejects a YAML stack manifest', () => {
      const bytes = encode('services:\n  web:\n    image: wordpress:6\n  db:\n    image: mysql:9');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('rejects arbitrary plain text', () => {
      const bytes = encode('just some random text');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });
  });

  describe('encoding', () => {
    it('rejects non-UTF-8 binary data', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not valid UTF-8');
    });

    it('rejects whitespace-only content', () => {
      const bytes = encode('   \n\n  ');
      const result = validateManifestContent(bytes);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty');
    });
  });
});
