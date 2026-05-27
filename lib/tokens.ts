import { randomBytes, createHash } from 'node:crypto';

/**
 * Generate a fresh magic-link token. 32 random bytes encoded as URL-safe
 * base64 (no padding) = 43 chars. The plaintext token is what we email to
 * the customer; only its hash is stored in the DB.
 */
export function generateMagicLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Deterministic SHA-256 hash of a token. Used to store tokens in the DB
 * without storing the plaintext — a DB leak alone can't grant access.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
