import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import * as ipaddr from 'ipaddr.js';

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
    if (/^metadata\./i.test(hostname) ||
        /^instance-data\./i.test(hostname) ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.localdomain')) {
      return false;
    }

    // Resolve hostname to IP for range checks.
    // Strip brackets for IPv6 literals (new URL() returns [::1] for IPv6).
    const cleanHostname = hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(cleanHostname)) {
      const addr = ipaddr.parse(cleanHostname);
      const range = addr.range();

      // Block dangerous ranges; allow loopback + private for dev
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
      '/proxy-provider': {
        target: 'https://localhost:8080', // Default, overridden by router
        changeOrigin: true,
        secure: false,
        pathRewrite: { '^/proxy-provider': '' },
        router: (req) => {
          // Dynamic target from X-Proxy-Target header (set by buildProviderFetchArgs)
          const target = req.headers['x-proxy-target'];
          if (target && typeof target === 'string' && isValidProxyTarget(target)) {
            return target;
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
  },
  html: {
    template: './index.html',
    templateParameters: {
      IS_DEV: process.env.NODE_ENV !== 'production',
    },
  },
});
