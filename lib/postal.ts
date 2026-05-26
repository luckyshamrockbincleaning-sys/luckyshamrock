/**
 * Postal-code utilities for Lucky Shamrock's service area.
 *
 * Default service area is Fort Saskatchewan (postal prefix `T8L`). The
 * prefix can be overridden at runtime via the `SERVICE_POSTAL_PREFIX`
 * env var so AB can test other cities without redeploying.
 */

const DEFAULT_PREFIX = 'T8L';

export function normalizePostalCode(input: string): string {
  if (!input) return '';
  return input.replace(/[\s\-]/g, '').toUpperCase();
}

export function isInServiceArea(postalCode: string): boolean {
  const normalized = normalizePostalCode(postalCode);
  if (!normalized) return false;
  const prefix = (process.env.SERVICE_POSTAL_PREFIX ?? DEFAULT_PREFIX).toUpperCase();
  return normalized.startsWith(prefix);
}
