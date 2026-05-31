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
    // Forces DATABASE_URL → TEST_DATABASE_URL before any test file imports
    // db/client.ts, so the truncate target is always the test database.
    globalSetup: ['./db/test-setup.ts'],
  },
});
