import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwa } from './src/pwa.ts';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
export default defineConfig({
  root: resolve('apps/web'),
  plugins: [
    react(),
    pwa(),
    {
      name: 'public-metadata-404',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/public/')) {
            const path = resolve('.runtime/public', '.' + req.url.split('?')[0]);
            if (!path.startsWith(resolve('.runtime/public') + '/') || !existsSync(path)) {
              res.statusCode = 404;
              res.end('Not found');
              return;
            }
          }
          next();
        });
      },
    },
  ],
  publicDir: resolve('.runtime/public'),
  server: {
    host: '127.0.0.1',
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve('.')],
      deny: [
        '**/.runtime/private/**',
        '**/.env*',
        '**/.dev.vars',
        '**/.git/**',
        '**/*.db',
        '**/*.db-*',
        '**/*.pem',
        '**/invitation-*.txt',
        '**/auth-secret',
      ],
    },
    headers: { 'Referrer-Policy': 'no-referrer' },
  },
  build: { outDir: resolve('dist/web'), emptyOutDir: true },
});
