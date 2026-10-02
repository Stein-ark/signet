import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceRoot = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': sourceRoot,
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // Integration tests start an in-memory MongoDB replica set, which takes a few seconds.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
