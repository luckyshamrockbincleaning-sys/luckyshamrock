import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/_tests/**/*.test.ts'],
    testTimeout: 10_000,
    pool: 'forks',
    // Serialize test files in one fork. Integration tests TRUNCATE the shared
    // Neon DB between cases, and parallel files race on that truncate. Single
    // fork keeps file isolation but runs them sequentially.
    poolOptions: { forks: { singleFork: true } },
  },
});
