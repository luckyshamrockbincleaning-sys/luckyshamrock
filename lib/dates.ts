/**
 * Format a calendar date ("YYYY-MM-DD", or anything starting with it) as a
 * friendly human string ("Thu, Jun 11, 2026") — matching how /manage renders
 * visit dates. Built from the date parts via Date.UTC so it is
 * timezone-independent (no UTC-midnight off-by-one).
 *
 * Shared by the booking confirmation (api/book.ts) and the done email
 * (lib/operator-handlers.ts) so every customer-facing email shows the same
 * date format.
 */
export function formatFriendlyDate(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return iso;
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-CA', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
