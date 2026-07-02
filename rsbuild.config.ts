import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import ipaddr from 'ipaddr.js';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
/**
 * Validate that a proxy target is a safe HTTP(S) URL.
 * Blocks non-HTTP protocols, credentials in URLs, cloud metadata endpoints,
 * and dangerous IP ranges (link-local, multicast, reserved, etc.).
 * Allows localhost and private ranges for local dev.
 */
function isValidProxyTarget(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    // Reject URLs with embedded credentials
    if (url.username || url.password) return false;

    const hostname = url.hostname;

    // Block internal hostname patterns (cloud metadata services)
    // and DNS-to-IP mapping services that can bypass IP-literal checks
    if (/^metadata\./i.test(hostname) ||
        /^instance-data\./i.test(hostname) ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.localdomain') ||
        /\.nip\.io$/i.test(hostname) ||
        /\.xip\.io$/i.test(hostname) ||
        /\.sslip\.io$/i.test(hostname)) {
      return false;
    }

    // Check IP literals for dangerous ranges (no DNS resolution — hostname bypass
    // is mitigated by the nip.io/xip.io/sslip.io blocks above).
    // Strip brackets for IPv6 literals (new URL() returns [::1] for IPv6).
    const cleanHostname = hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(cleanHostname)) {
      const addr = ipaddr.parse(cleanHostname);
      const range = addr.range();

      // Block dangerous ranges; allow loopback + IPv4 private for dev
      const blocked = new Set([
        'linkLocal',       // 169.254.x.x — cloud metadata
        'ipv4Mapped',      // ::ffff:0:0/96 — could map to any blocked IPv4
        'unspecified',     // 0.0.0.0
        'multicast',       // 224.0.0.0/4
        'reserved',        // 240.0.0.0/4 etc
        'benchmarking',    // 198.18.0.0/15
        '6to4',            // 2002::/16
        'teredo',          // 2001:0000::/32
        'uniqueLocal',     // fc00::/7
      ]);

      if (blocked.has(range)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

// Minimal structural shapes for the rspack hooks we tap (avoids depending on
// @rsbuild/core's exported plugin-type surface). Methods are bivariant, so these
// narrow shapes are assignable where the full Compiler is expected.
interface ResolveData {
  request?: string;
  contextInfo?: { issuer?: string };
}
interface StatsModule {
  name?: string;
  identifier?: string;
  modules?: StatsModule[];
}
interface RspackCompilerLike {
  options: { mode?: string };
  outputPath: string;
  hooks: {
    normalModuleFactory: {
      tap(
        name: string,
        fn: (nmf: {
          hooks: { beforeResolve: { tap(name: string, fn: (data: ResolveData) => void): void } };
        }) => void,
      ): void;
    };
    done: {
      tap(name: string, fn: (stats: { toJson(opts: Record<string, boolean>): { modules?: StatsModule[] } }) => void): void;
    };
  };
}

/**
 * Fails the build if a node-only module resolves into the browser graph.
 * See migration spec §4 risk 5. undici/node:async_hooks are skipped for the
 * benign @modelcontextprotocol/sdk (reached via the chain faucet barrel but
 * tree-shaken out of OUTPUT — asserted separately by scripts/check-bundle.mjs).
 */
class ForbidNodeOnlyBrowserImportsPlugin {
  apply(compiler: RspackCompilerLike): void {
    compiler.hooks.normalModuleFactory.tap('ForbidNodeOnlyBrowserImports', (nmf) => {
      nmf.hooks.beforeResolve.tap('ForbidNodeOnlyBrowserImports', (data) => {
        const req = data.request ?? '';
        const issuer = data.contextInfo?.issuer ?? '';
        const always: { name: string; re: RegExp }[] = [
          { name: 'core guarded-fetch (node-only SSRF)', re: /guarded-fetch(\.[mc]?js)?$/ },
          { name: 'fred node server barrel', re: /manifest-mcp-fred[\\/].*server(\/|\.|$)/ },
          { name: 'sdk node subpath', re: /manifest-sdk[\\/](dist[\\/])?node(\.[mc]?js)?$/ },
        ];
        for (const { name, re } of always) {
          if (re.test(req)) {
            throw new Error(`[browser-safety] forbidden node-only import "${req}" (${name}) from ${issuer || 'entry'} — migration spec §4 risk 5.`);
          }
        }
        const benignIssuer = /node_modules[\\/](@modelcontextprotocol[\\/]sdk|@manifest-network[\\/]manifest-mcp-chain)[\\/]/.test(issuer);
        if (!benignIssuer) {
          const builtins: { name: string; re: RegExp }[] = [
            { name: 'undici', re: /^undici(\/|$)/ },
            { name: 'node:async_hooks', re: /^(node:)?async_hooks$/ },
          ];
          for (const { name, re } of builtins) {
            if (re.test(req)) {
              throw new Error(`[browser-safety] node builtin "${req}" (${name}) reached the browser graph from ${issuer || 'entry'} — migration spec §4 risk 5.`);
            }
          }
        }
      });
    });
  }
}

/**
 * Emits dist/bundle-modules.json — the bundled module paths for
 * manifest-mcp-core / manifestjs / @modelcontextprotocol/sdk. Consumed by
 * scripts/check-bundle.mjs for the single-copy + no-MCP-sdk assertions.
 */
class EmitBundleModulesPlugin {
  apply(compiler: RspackCompilerLike): void {
    compiler.hooks.done.tap('EmitBundleModules', (stats) => {
      if (compiler.options.mode !== 'production') return;
      const json = stats.toJson({ all: false, modules: true, nestedModules: true });
      const names = new Set<string>();
      const walk = (mods: StatsModule[] | undefined): void => {
        for (const m of mods ?? []) {
          if (m.name) names.add(m.name);
          if (m.identifier) names.add(m.identifier);
          if (m.modules) walk(m.modules);
        }
      };
      walk(json.modules);
      const relevant = [...names].filter((n) =>
        /@manifest-network[\\/](manifest-mcp-core|manifestjs)|@modelcontextprotocol[\\/]sdk/.test(n),
      );
      writeFileSync(join(compiler.outputPath, 'bundle-modules.json'), JSON.stringify(relevant, null, 2));
    });
  }
}

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginNodePolyfill(),
  ],
  dev: {
    lazyCompilation: false,
  },
  tools: {
    rspack: {
      node: {
        __filename: 'mock',
        __dirname: 'mock',
      },
      plugins: [new ForbidNodeOnlyBrowserImportsPlugin(), new EmitBundleModulesPlugin()],
    },
  },
  server: {
    proxy: {
      '/api/morpheus': (() => {
        const morpheusUrl = process.env.PUBLIC_MORPHEUS_URL || 'https://api.mor.org/api/v1';
        const morpheusApiKey = process.env.MORPHEUS_API_KEY || '';
        const parsed = new URL(morpheusUrl);
        // pathRewrite: strip /api/morpheus, replace with upstream pathname
        const upstreamPath = parsed.pathname.replace(/\/+$/, '');
        return {
          target: parsed.origin,
          changeOrigin: true,
          secure: true,
          pathRewrite: { '^/api/morpheus': upstreamPath },
          // Fast-fail when no API key is configured (mirrors nginx 503 guard)
          bypass: (_req: unknown, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void }): undefined => {
            if (!morpheusApiKey) {
              res.writeHead(503, { 'Content-Type': 'text/plain' });
              res.end('Morpheus API key (MORPHEUS_API_KEY) not configured');
            }
          },
          onProxyReq: (proxyReq: { setHeader: (name: string, value: string) => void }) => {
            proxyReq.setHeader('Authorization', `Bearer ${morpheusApiKey}`);
          },
        };
      })(),
      '/proxy-provider': {
        target: 'https://localhost:8080', // Default, overridden by router
        changeOrigin: true,
        secure: false,
        ws: true,
        pathRewrite: { '^/proxy-provider': '' },
        router: (req) => {
          // Dynamic target from X-Proxy-Target header (set by buildProviderFetchArgs)
          const target = req.headers['x-proxy-target'];
          if (target && typeof target === 'string' && isValidProxyTarget(target)) {
            return target;
          }
          // Fallback: check `target` query param for WebSocket connections
          // (browser WebSocket API cannot set custom headers)
          const url = new URL(req.url || '', 'http://localhost');
          const qTarget = url.searchParams.get('target');
          if (qTarget && isValidProxyTarget(qTarget)) {
            return qTarget;
          }
          return 'https://localhost:8080';
        },
      },
    },
  },
  source: {
    entry: {
      index: './src/main.tsx',
    },
    define: {
      'import.meta.env.APP_VERSION': JSON.stringify(pkg.version),
    },
  },
  html: {
    template: './index.html',
    templateParameters: {
      IS_DEV: process.env.NODE_ENV !== 'production',
    },
  },
  performance: {
    chunkSplit: {
      strategy: 'split-by-experience',
      override: {
        cacheGroups: {
          cosmos: {
            test: /[\\/]node_modules[\\/](@cosmos-kit|@interchain-ui|chain-registry)[\\/]/,
            name: 'vendor-cosmos',
            priority: 20,
          },
          manifest: {
            test: /[\\/]node_modules[\\/](@cosmjs|@manifest-network)[\\/]/,
            name: 'vendor-manifest',
            priority: 20,
          },
          web3auth: {
            test: /[\\/]node_modules[\\/](@web3auth|@toruslabs)[\\/]/,
            name: 'vendor-web3auth',
            priority: 20,
          },
        },
      },
    },
  },
});
