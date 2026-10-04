import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: {
    environment: 'jsdom',
    setupFiles: './src/testSetup.ts',
    // Ant Design interaction tests are CPU-heavy in jsdom. Bound concurrency
    // and allow slower CI runners to complete them without timing out midway
    // through an interaction and leaking unfinished work into the next test.
    ...(process.env.CI ? { maxWorkers: 2, testTimeout: 15_000 } : {}),
  },
});
