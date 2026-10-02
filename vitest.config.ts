import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/src/api.ts', 'web/src/format.ts'],
      exclude: ['src/demo.ts'],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 75 },
    },
  },
});
