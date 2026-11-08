import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    cors: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
