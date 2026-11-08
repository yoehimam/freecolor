import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    cors: true,
    watch: {
      ignored: [
        '**/scratch/**',
        '**/android/**',
        '**/.git/**',
        '**/dist/**',
        '**/*.apk',
      ],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
