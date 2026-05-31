/**
 * Vitest globalSetup — runs once before any test file.
 *
 * Forces the entire test run to use TEST_DATABASE_URL instead of
 * DATABASE_URL so that `truncateAllForTests()` can never accidentally
 * wipe the production Neon database when `npm test` is run locally
 * against `.env.local` (which holds the prod URL).
 *
 * Fails loud if TEST_DATABASE_URL is missing or equal to DATABASE_URL.
 */
export default function setup(): void {
  const prodUrl = process.env.DATABASE_URL;
  const testUrl = process.env.TEST_DATABASE_URL;
  const testUrlUnpooled = process.env.TEST_DATABASE_URL_UNPOOLED;

  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Tests truncate the database between cases — ' +
        'set TEST_DATABASE_URL to a separate Neon database (e.g. neondb_test) ' +
        'in .env.local. See .env.example.',
    );
  }
  if (prodUrl && testUrl === prodUrl) {
    throw new Error(
      'TEST_DATABASE_URL is equal to DATABASE_URL — refusing to run tests against ' +
        'the production database. Point TEST_DATABASE_URL at a separate Neon database.',
    );
  }

  process.env.DATABASE_URL = testUrl;
  if (testUrlUnpooled) {
    process.env.DATABASE_URL_UNPOOLED = testUrlUnpooled;
  }
  // Marker that truncateAllForTests checks before nuking anything.
  process.env.LUCKYSHAMROCK_TEST_RUN = '1';
}
