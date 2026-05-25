import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL_UNPOOLED or DATABASE_URL must be set for drizzle-kit. Run `vercel env pull .env.local`.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
