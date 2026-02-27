import { readFileSync } from 'node:fs';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import * as ipaddr from 'ipaddr.js';

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
    },
  },
  server: {
    proxy: {
      '/proxy-morpheus': {
        target: 'https://api.mor.org', // Default, overridden by router
        changeOrigin: true,
        secure: true,
        pathRewrite: { '^/proxy-morpheus': '' },
        router: (req) => {
          const target = req.headers['x-proxy-target'];
          if (target && typeof target === 'string' && isValidProxyTarget(target)) {
            return target;
          }
          return 'https://api.mor.org';
        },
      },
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
});
