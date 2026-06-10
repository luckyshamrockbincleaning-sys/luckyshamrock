import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function init() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Did you run `vercel env pull .env.local`?'
    );
  }
  _sql = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ssl: 'require',
  });
  _db = drizzle(_sql);
}

export function getDb() {
  if (!_db) init();
  return _db!;
}

export function getRawClient() {
  if (!_sql) init();
  return _sql!;
}

/**
 * Test-only helper. Truncates all booking-domain tables in dependency order.
 * Do NOT call from application code. Imported only by integration tests.
 *
 * Guarded by the LUCKYSHAMROCK_TEST_RUN marker that db/test-setup.ts sets as
 * a vitest globalSetup. Without that marker (or with DATABASE_URL still
 * pointing at TEST_DATABASE_URL's pair), this throws — the NODE_ENV check
 * alone wasn't enough because vitest doesn't set it, and .env.local holds
 * the production URL.
 */
export async function truncateAllForTests(): Promise<void> {
  if (process.env.LUCKYSHAMROCK_TEST_RUN !== '1') {
    throw new Error(
      'truncateAllForTests called outside a vitest run — refusing to truncate. ' +
        'If you are running tests, ensure vitest.config.ts includes ' +
        'globalSetup: ["./db/test-setup.ts"] and TEST_DATABASE_URL is set.',
    );
  }
  if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
    throw new Error(
      'DATABASE_URL has drifted from TEST_DATABASE_URL — refusing to truncate. ' +
        'This indicates the globalSetup did not run or something overwrote DATABASE_URL mid-test.',
    );
  }
  const sql = getRawClient();
  await sql`TRUNCATE
    payment,
    notification_log,
    magic_link_token,
    visit,
    subscription,
    customer,
    waitlist
  CASCADE`;
}
