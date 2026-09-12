import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('apps/intake'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
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
    proxy: { '/private': 'http://127.0.0.1:8787' },
  },
  build: { outDir: resolve('dist/intake'), emptyOutDir: true },
});
