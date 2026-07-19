/**
 * Business launch date: routes start July 23, 2026. Until then, no clean may
 * be scheduled — booking stays open (pre-orders are good business) but every
 * generated visit date is floored to launch day.
 *
 * After launch day this module becomes a no-op (max(now, launch) === now), so
 * it's safe to leave wired in forever — no cleanup deploy needed.
 */

export const LAUNCH_DATE_ISO = '2026-07-23';

// Floor for schedule generation. generateVisitDates/generateSeasonalDates
// return dates STRICTLY AFTER their startDate, so the floor is launch − 1
// (July 22) — that allows a first clean ON launch day itself.
const SCHEDULE_FLOOR = new Date('2026-07-22T12:00:00Z');

/**
 * The startDate to feed schedule generation: now, but never earlier than the
 * day before launch. Injectable `now` for tests.
 */
export function effectiveStartDate(now: Date = new Date()): Date {
  return now.getTime() < SCHEDULE_FLOOR.getTime() ? SCHEDULE_FLOOR : now;
}
