import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/index.ts'],
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov']
    },
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
