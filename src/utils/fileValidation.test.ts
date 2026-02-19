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

const encode = (text: string) => new TextEncoder().encode(text);

describe('validateManifestContent', () => {
  describe('JSON files', () => {
    it('accepts valid single-service manifest', () => {
      const bytes = encode(JSON.stringify({ image: 'redis:8', ports: { '6379/tcp': {} } }));
      expect(validateManifestContent(bytes, 'app.json')).toEqual({ valid: true });
    });

    it('accepts valid stack manifest', () => {
      const bytes = encode(JSON.stringify({
        services: {
          web: { image: 'wordpress:6', ports: { '80/tcp': {} } },
          db: { image: 'mysql:9' },
        },
      }));
      expect(validateManifestContent(bytes, 'stack.json')).toEqual({ valid: true });
    });

    it('rejects invalid JSON syntax', () => {
      const bytes = encode('{ image: "redis" }');
      const result = validateManifestContent(bytes, 'bad.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('rejects JSON array', () => {
      const bytes = encode('[1, 2, 3]');
      const result = validateManifestContent(bytes, 'arr.json');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Manifest must be a JSON object');
    });

    it('rejects JSON without image or services', () => {
      const bytes = encode(JSON.stringify({ ports: { '80/tcp': {} } }));
      const result = validateManifestContent(bytes, 'no-image.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing a valid "image" field');
    });

    it('rejects stack with empty services', () => {
      const bytes = encode(JSON.stringify({ services: {} }));
      const result = validateManifestContent(bytes, 'empty.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least one service');
    });

    it('rejects stack service missing image', () => {
      const bytes = encode(JSON.stringify({ services: { web: { ports: {} } } }));
      const result = validateManifestContent(bytes, 'no-img.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Service "web" is missing a valid "image"');
    });

    it('rejects services as array', () => {
      const bytes = encode(JSON.stringify({ services: [{ image: 'redis' }] }));
      const result = validateManifestContent(bytes, 's.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('"services" must be an object');
    });

    it('rejects service config as non-object', () => {
      const bytes = encode(JSON.stringify({ services: { web: 'wordpress' } }));
      const result = validateManifestContent(bytes, 's.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Service "web" must be an object');
    });

    it('rejects uppercase service name', () => {
      const bytes = encode(JSON.stringify({ services: { MyDB: { image: 'mysql:9' } } }));
      const result = validateManifestContent(bytes, 'stack.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "MyDB"');
    });

    it('rejects service name with underscores', () => {
      const bytes = encode(JSON.stringify({ services: { my_db: { image: 'mysql:9' } } }));
      const result = validateManifestContent(bytes, 'stack.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "my_db"');
    });

    it('rejects service name with colon', () => {
      const bytes = encode(JSON.stringify({ services: { 'web:server': { image: 'nginx:1' } } }));
      const result = validateManifestContent(bytes, 'stack.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "web:server"');
    });

    it('rejects service name starting with hyphen', () => {
      const bytes = encode(JSON.stringify({ services: { '-web': { image: 'nginx:1' } } }));
      const result = validateManifestContent(bytes, 'stack.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid service name "-web"');
    });
  });

  describe('YAML files', () => {
    it('accepts YAML with top-level image', () => {
      const bytes = encode('image: redis:8\nports:\n  6379/tcp: {}');
      expect(validateManifestContent(bytes, 'app.yaml')).toEqual({ valid: true });
    });

    it('accepts YAML with top-level services', () => {
      const bytes = encode('services:\n  web:\n    image: wordpress:6');
      expect(validateManifestContent(bytes, 'stack.yml')).toEqual({ valid: true });
    });

    it('rejects YAML without image or services', () => {
      const bytes = encode('ports:\n  80/tcp: {}');
      const result = validateManifestContent(bytes, 'bad.yaml');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('"image" or "services"');
    });
  });

  describe('.txt files', () => {
    it('accepts valid JSON in .txt', () => {
      const bytes = encode(JSON.stringify({ image: 'nginx:1' }));
      expect(validateManifestContent(bytes, 'app.txt')).toEqual({ valid: true });
    });

    it('falls back to YAML check for non-JSON .txt', () => {
      const bytes = encode('image: nginx:1\nports:\n  80/tcp: {}');
      expect(validateManifestContent(bytes, 'app.txt')).toEqual({ valid: true });
    });

    it('rejects .txt with neither valid JSON nor YAML structure', () => {
      const bytes = encode('just some random text');
      const result = validateManifestContent(bytes, 'notes.txt');
      expect(result.valid).toBe(false);
    });
  });

  describe('encoding', () => {
    it('rejects non-UTF-8 binary data', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
      const result = validateManifestContent(bytes, 'binary.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not valid UTF-8');
    });

    it('rejects whitespace-only content', () => {
      const bytes = encode('   \n\n  ');
      const result = validateManifestContent(bytes, 'empty.json');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty');
    });
  });
});
