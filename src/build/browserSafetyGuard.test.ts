import { describe, it, expect } from 'vitest';
import { forbiddenNodeOnlyImport } from '../../scripts/browser-safety-guard.mjs';

// Unit tests for the browser-safety tripwire predicate extracted from
// rsbuild.config.ts's ForbidNodeOnlyBrowserImportsPlugin. See migration spec §4
// risk 5. The plugin throws whenever this returns a non-null reason string.
describe('forbiddenNodeOnlyImport', () => {
  describe('always-forbidden node-only imports (reason regardless of issuer)', () => {
    const appIssuer = '/app/src/main.tsx';
    const nodeIssuer = '/app/node_modules/@modelcontextprotocol/sdk/dist/client.js';

    it('flags core guarded-fetch from any issuer', () => {
      const req = '/app/node_modules/@manifest-network/manifest-mcp-core/dist/guarded-fetch.js';
      expect(forbiddenNodeOnlyImport(req, appIssuer)).toMatch(/guarded-fetch/);
      // Even a benign issuer cannot suppress an always-forbidden import.
      expect(forbiddenNodeOnlyImport(req, nodeIssuer)).toMatch(/guarded-fetch/);
    });

    it('flags the fred node server barrel from any issuer', () => {
      const req = '/app/node_modules/@manifest-network/manifest-mcp-fred/dist/server/index.js';
      expect(forbiddenNodeOnlyImport(req, appIssuer)).toMatch(/fred node server barrel/);
      expect(forbiddenNodeOnlyImport(req, nodeIssuer)).toMatch(/fred node server barrel/);
    });

    it('flags the sdk node subpath from any issuer', () => {
      const req = '@manifest-network/manifest-sdk/node';
      expect(forbiddenNodeOnlyImport(req, appIssuer)).toMatch(/sdk node subpath/);
      expect(forbiddenNodeOnlyImport(req, nodeIssuer)).toMatch(/sdk node subpath/);
    });
  });

  describe('node builtins gated by issuer', () => {
    it('flags undici / async_hooks from a normal issuer', () => {
      expect(forbiddenNodeOnlyImport('undici', '/app/src/main.tsx')).toMatch(/undici/);
      expect(forbiddenNodeOnlyImport('undici/index.js', '/app/src/main.tsx')).toMatch(/undici/);
      expect(forbiddenNodeOnlyImport('async_hooks', '/app/src/main.tsx')).toMatch(/async_hooks/);
      expect(forbiddenNodeOnlyImport('node:async_hooks', '/app/src/main.tsx')).toMatch(/async_hooks/);
    });

    it('allows undici / async_hooks reached via the @modelcontextprotocol/sdk barrel', () => {
      const iss = '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
      expect(forbiddenNodeOnlyImport('undici', iss)).toBeNull();
      expect(forbiddenNodeOnlyImport('node:async_hooks', iss)).toBeNull();
    });
    // ENG-312 Phase 9: barney dropped the direct manifest-mcp-chain dep and it
    // left the tree entirely (the SDK depends on core + fred, not chain), so the
    // old mcp-chain benign-issuer branch is gone — nothing left to whitelist.
  });

  describe('no false positives (anchored fred-server regex + normal imports)', () => {
    it('does not flag a browser-safe fred module that merely ends in "server"', () => {
      // "observer.js" embeds "server" mid-segment — the anchored regex requires a
      // path-segment boundary, so this browser-safe module must NOT trip.
      const req = '/app/node_modules/@manifest-network/manifest-mcp-fred/dist/observer.js';
      expect(forbiddenNodeOnlyImport(req, '/app/src/main.tsx')).toBeNull();
    });

    it('does not flag a normal app import', () => {
      expect(forbiddenNodeOnlyImport('react', '/app/src/main.tsx')).toBeNull();
      expect(forbiddenNodeOnlyImport('./helpers', '/app/src/ai/toolExecutor/index.ts')).toBeNull();
    });

    it('handles undefined request/issuer without throwing', () => {
      expect(forbiddenNodeOnlyImport(undefined, undefined)).toBeNull();
    });
  });
});
