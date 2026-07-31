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
