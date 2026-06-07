import type { Cadence } from './schedule.js';

/**
 * Server-side source of truth for per-clean pricing, in CENTS. The operator
 * charge path computes the amount here — never from a client-supplied figure.
 * Mirrors the storefront copy (One-Time $45 / Monthly $35 / Three Wash $105,
 * extra bins $12/clean).
 *
 * Recurring plans are billed per-visit at the per-clean rate; a one-off visit
 * (no subscription) uses the one-off rate. Keep in sync with components-mid.jsx
 * + components-booking.jsx if prices change.
 */

// Per-clean price in cents, by cadence (recurring visits).
const CADENCE_PRICE_CENTS: Record<Cadence, number> = {
  monthly: 3500,
  bimonthly: 3500, // legacy plan, not sold; price defensively
  quarterly: 10500, // legacy
  seasonal: 10500, // Three Wash Season: $105 for the season (billed per wash below)
};

// One-off (no subscription) per-clean price in cents.
const ONEOFF_PRICE_CENTS = 4500;
const EXTRA_BIN_PRICE_CENTS = 1200;

function withExtraBins(firstBinPriceCents: number, binCount: number): number {
  const bins = Math.max(1, binCount || 1);
  return firstBinPriceCents + Math.max(0, bins - 1) * EXTRA_BIN_PRICE_CENTS;
}

/**
 * The base (pre-discount) charge for a single clean, in cents.
 * - One-off (cadence null): flat one-off rate for first bin + $12 per extra bin.
 * - Seasonal: $105 covers the SEASON (3 washes), so each wash bills 1/3 — the
 *   customer pays $105/yr total across 3 visits for the first bin, then $12 per
 *   extra bin per clean.
 * - Other recurring: per-clean rate for first bin + $12 per extra bin.
 */
export function baseChargeCents(cadence: Cadence | null, binCount: number): number {
  if (cadence === null) return withExtraBins(ONEOFF_PRICE_CENTS, binCount);
  if (cadence === 'seasonal') return withExtraBins(Math.round(CADENCE_PRICE_CENTS.seasonal / 3), binCount);
  return withExtraBins(CADENCE_PRICE_CENTS[cadence], binCount);
}

/**
 * Final amount to charge after an operator's on-the-spot discount (cents).
 * Discount is clamped to [0, base] so it can never produce a negative charge.
 */
export function finalChargeCents(base: number, discountCents: number): number {
  const d = Math.max(0, Math.min(discountCents || 0, base));
  return base - d;
}
