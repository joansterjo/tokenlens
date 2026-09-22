import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: mode === 'store' ? 'dist-store' : mode === 'development' ? 'dist-dev' : 'dist',
    sourcemap: false,
    rollupOptions: { input: {
      panel: resolve('src/panel/panel.html'), sidebar: resolve('src/sidebar/sidebar.html'),
    }, output: { entryFileNames: (chunk) => chunk.name === 'content' ? 'assets/content.js' : 'assets/[name]-[hash].js' } },
  },
}));
