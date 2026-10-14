import { defineConfig } from 'vitest/config';

export default defineConfig({
  // n8n-workflow ships source maps without their sources: keep the test output readable
  logLevel: 'error',
  test: {
    include: ['test/**/*.test.ts'],
  },
});
