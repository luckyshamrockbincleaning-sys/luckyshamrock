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
 */
export async function truncateAllForTests(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('truncateAllForTests must not run in production');
  }
  const sql = getRawClient();
  await sql`TRUNCATE
    notification_log,
    magic_link_token,
    visit,
    subscription,
    customer,
    waitlist
  CASCADE`;
}
