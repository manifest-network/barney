import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';

/**
 * Validate that a proxy target is a well-formed HTTP(S) URL.
 * Blocks non-HTTP protocols to prevent protocol smuggling.
 */
function isValidProxyTarget(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:';
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
