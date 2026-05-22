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
