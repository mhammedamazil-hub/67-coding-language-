import { defineConfig } from 'vite';

// Relative base so the built site works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
