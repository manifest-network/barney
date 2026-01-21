import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';

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
          // Dynamic target from X-Proxy-Target header
          const target = req.headers['x-proxy-target'];
          if (target && typeof target === 'string') {
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
  },
});
