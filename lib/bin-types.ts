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
 * constraint (`*_bin_types_match_count`). The list is a MULTISET — ['garbage',
 * 'garbage', 'organics'] is two black bins and a green one — so that
 * constraint is now the whole invariant rather than a side effect of the
 * entries being distinct.
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
  const out: BinType[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!isBinType(v)) return null;
    out.push(v);
  }
  if (out.length === 0) return null;
  // A MULTISET, not a set: a household with two black bins is a real customer.
  // Distinctness used to stand in for the count agreeing with bin_count; now
  // the database CHECK constraint carries that job outright, which is a
  // stronger guarantee than the one it replaces.
  return out.sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

/**
 * Human summary for a stop card or a receipt. Falls back to the bare count for
 * the bookings taken before this field existed — they must keep rendering.
 */
export function describeBins(types: readonly string[] | null | undefined, count: number): string {
  const normalized = types && types.length > 0 ? normalizeBinTypes([...types]) : null;
  if (normalized === null) return `${count} bin${count === 1 ? '' : 's'}`;
  const totals = tally(normalized);
  return [...totals.entries()]
    .map(([t, n]) => (n > 1 ? `${BIN_TYPE_SHORT[t]} ×${n}` : BIN_TYPE_SHORT[t]))
    .join(' + ');
}

function tally(types: readonly BinType[]): Map<BinType, number> {
  const totals = new Map<BinType, number>();
  for (const t of types) totals.set(t, (totals.get(t) ?? 0) + 1);
  return totals;
}

/**
 * One display label per bin position, numbered ONLY where a type repeats.
 *
 * A lone green bin reads "Green bin", never "Green bin 1" — the number would
 * imply a second one exists and was missed. Legacy rows with no types fall
 * back to positions so the photo steps still have something to say.
 */
export function binLabelsFor(
  types: readonly string[] | null | undefined,
  count: number,
): string[] {
  const normalized = types && types.length > 0 ? normalizeBinTypes([...types]) : null;
  if (normalized === null) {
    return Array.from({ length: Math.max(1, count) }, (_, i) => `Bin ${i + 1}`);
  }
  const totals = tally(normalized);
  const seen = new Map<BinType, number>();
  return normalized.map((t) => {
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return totals.get(t)! > 1 ? `${BIN_TYPE_SHORT[t]} ${n}` : BIN_TYPE_SHORT[t];
  });
}
