/**
 * One-off: give every pre-existing customer a referral code.
 *
 * New customers get a code at booking (see api/book.ts). This covers the rows
 * that predate the feature so /manage is never blank for them. Idempotent —
 * only touches rows where referral_code IS NULL, so it is safe to re-run.
 *
 * Run once per database:
 *   npx dotenv -e .env.local -- npx tsx db/backfill-referral-codes.ts
 *
 * Point it at a specific database by overriding DATABASE_URL, e.g. for the
 * test DB:
 *   DATABASE_URL="$TEST_DATABASE_URL" npx dotenv -e .env.local -- npx tsx db/backfill-referral-codes.ts
 */
import { eq, isNull } from 'drizzle-orm';
import { getDb } from './client.js';
import { customer } from './schema.js';
import { generateReferralCode } from '../lib/referral.js';

async function main(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: customer.id, email: customer.email })
    .from(customer)
    .where(isNull(customer.referralCode));

  console.log(`[backfill] ${rows.length} customer(s) without a referral code`);

  for (const row of rows) {
    // Retry on the astronomically unlikely unique collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateReferralCode();
      try {
        await db.update(customer).set({ referralCode: code }).where(eq(customer.id, row.id));
        console.log(`[backfill] ${row.email} -> ${code}`);
        break;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
  }

  console.log('[backfill] done');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
