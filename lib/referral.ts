/**
 * Referral codes and reward accounting.
 *
 * Kept deliberately dependency-light: this module is imported by BOTH
 * lib/operator-handlers.ts and lib/billing-webhook.ts. Importing
 * operator-handlers from the webhook would drag sharp + gifenc + the ~947 KB
 * sprite module into the Stripe webhook's serverless bundle — the same trap
 * lib/walkup-email.ts was carved out to avoid. Import only db + schema here.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { customer } from '../db/schema.js';
import type { getDb } from '../db/client.js';

/** The drizzle handle. Type-only import — no runtime dependency added. */
type Db = ReturnType<typeof getDb>;

/** Both sides of a successful referral get $5. Single source of truth. */
export const REFERRAL_REWARD_CENTS = 500;

export const REFERRAL_CODE_LENGTH = 6;

// No 0/O and no 1/I/L: these codes get said out loud over a fence and typed
// from memory, so visual and audible ambiguity costs real conversions.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A fresh referral code. 31^6 ≈ 887M combinations — this is not a secret
 * (guessing one earns $5 and reveals a first name), but the space is far too
 * large to brute-force over HTTP, and `check_referral` never confirms a miss
 * differently from a hit.
 */
export function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Accept what a human actually types: lowercase, spaces, hyphens. */
export function normalizeReferralCode(input: string): string {
  if (!input) return '';
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Atomically consume up to `maxCents` of a customer's credit. Returns the
 * amount actually consumed (0 if they had none).
 *
 * The `gte` guard in the WHERE clause is what makes this safe: two visits for
 * the same customer completed concurrently cannot both spend the same dollar,
 * because only one UPDATE will match. A caller that gets 0 back simply charges
 * full price — never a negative balance, never a double-spend.
 */
export async function spendCredit(db: Db, customerId: string, maxCents: number): Promise<number> {
  if (maxCents <= 0) return 0;

  const [row] = await db
    .select({ creditCents: customer.creditCents })
    .from(customer)
    .where(eq(customer.id, customerId));

  const available = row?.creditCents ?? 0;
  const applied = Math.min(available, maxCents);
  if (applied <= 0) return 0;

  const updated = await db
    .update(customer)
    .set({ creditCents: sql`${customer.creditCents} - ${applied}` })
    .where(and(eq(customer.id, customerId), gte(customer.creditCents, applied)))
    .returning({ id: customer.id });

  return updated.length > 0 ? applied : 0;
}

/**
 * Pay a referrer, exactly once, for a friend whose first clean just settled.
 *
 * Called from TWO places — handleDone (card/cash/terminal settle synchronously)
 * and billing-webhook (a QR payment confirms asynchronously). Idempotency comes
 * from the `referral_awarded_at IS NULL` guard in the WHERE clause: the second
 * caller updates zero rows and returns without crediting anyone, so a Stripe
 * redelivery or a double-tapped Done cannot pay twice.
 *
 * Callers must only invoke this when money actually moved. A comped clean must
 * never trigger it.
 */
export async function awardReferralIfEarned(
  db: Db,
  friendCustomerId: string,
): Promise<{ awarded: boolean; referrerId: string | null }> {
  const [friend] = await db
    .select({ referredBy: customer.referredBy, awardedAt: customer.referralAwardedAt })
    .from(customer)
    .where(eq(customer.id, friendCustomerId));

  if (!friend?.referredBy || friend.awardedAt) return { awarded: false, referrerId: null };

  // Claim the payout first. Whoever wins this UPDATE owns the credit.
  const claimed = await db
    .update(customer)
    .set({ referralAwardedAt: new Date() })
    .where(and(eq(customer.id, friendCustomerId), isNull(customer.referralAwardedAt)))
    .returning({ id: customer.id });
  if (claimed.length === 0) return { awarded: false, referrerId: null };

  await db
    .update(customer)
    .set({ creditCents: sql`${customer.creditCents} + ${REFERRAL_REWARD_CENTS}` })
    .where(eq(customer.id, friend.referredBy));

  return { awarded: true, referrerId: friend.referredBy };
}
