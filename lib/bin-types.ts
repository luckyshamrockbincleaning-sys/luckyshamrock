/**
 * Which bins a job covers.
 *
 * Booking used to ask only "how many garbage bins?", which meant a one-bin
 * order reached the route card as the number 1 with no way to tell whether the
 * customer meant their black bin or their green one. The operator's own visit
 * notes had been saying "the green bin" for weeks — the vocabulary existed
 * everywhere except in the data.
 *
 * `bin_count` remains the source of truth for money and for photo pairing;
 * this is the descriptive companion, and the two are kept in step by a CHECK
 * constraint (`*_bin_types_match_count`).
 *
 * Dependency-light on purpose — imported by request-path code and by the
 * email templates.
 */

// Recycling is deliberately absent: Lucky Shamrock doesn't service blue
// bins. Re-adding one is a three-line change here plus the same entry in
// pricing.js — the sync test will tell you if you only do one of them.
export const BIN_TYPES = ['garbage', 'organics'] as const;

export type BinType = (typeof BIN_TYPES)[number];

/** Long form, for pickers where the customer is choosing. */
export const BIN_TYPE_LABEL: Record<BinType, string> = {
  garbage: 'Black · garbage',
  organics: 'Green · organics',
};

/** Short form, for route cards, receipts and email section headings. */
export const BIN_TYPE_SHORT: Record<BinType, string> = {
  garbage: 'Black bin',
  organics: 'Green bin',
};

const ORDER = new Map<BinType, number>(BIN_TYPES.map((t, i) => [t, i]));

function isBinType(value: string): value is BinType {
  return (BIN_TYPES as readonly string[]).includes(value);
}

/**
 * Validate and canonicalise a selection, or null if it isn't one.
 *
 * Sorting is load-bearing rather than cosmetic: photos, the per-bin email
 * sections and the receipt are all keyed by position, so "bin 1" has to mean
 * the same bin every visit regardless of the order the boxes were ticked.
 */
export function normalizeBinTypes(input: unknown): BinType[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = new Set<BinType>();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!isBinType(v)) return null;
    out.add(v);
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

/**
 * Human summary for a stop card or a receipt. Falls back to the bare count for
 * the bookings taken before this field existed — they must keep rendering.
 */
export function describeBins(types: readonly string[] | null | undefined, count: number): string {
  const normalized = types && types.length > 0 ? normalizeBinTypes([...types]) : null;
  if (normalized === null) return `${count} bin${count === 1 ? '' : 's'}`;
  return normalized.map((t) => BIN_TYPE_SHORT[t]).join(' + ');
}
