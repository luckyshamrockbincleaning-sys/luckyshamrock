/**
 * The cleaning season.
 *
 * Bin cleaning is a pressure-washing business in Fort Saskatchewan — it cannot
 * run through an Alberta winter. The season is **May 1 to October 31**, and no
 * visit may ever be scheduled outside it.
 *
 * This module exists because visit generation was originally season-blind:
 * booking a monthly plan produced 12 visits at a flat 28-day interval, which
 * happily scheduled cleans through January. Worse, the /api/me top-up would
 * regenerate them after any manual cleanup, because it only counted visits
 * rather than checking whether they were possible. Two real customers
 * (2026-08-05 and 2026-08-07) each had 7 winter cleans booked before this
 * was caught.
 *
 * All dates here are compared in UTC. Visit rows are stored at UTC noon, which
 * keeps the calendar day stable either side of a Mountain-Time offset.
 */

/** Human-readable season, for customer-facing copy. Keep in sync with the months below. */
export const SEASON_LABEL = 'May 1 – October 31';

/** May. Season opens on the 1st. */
export const SEASON_START_MONTH = 5;
/** October. Season closes on the 31st, inclusive. */
export const SEASON_END_MONTH = 10;

/** Is this date within the May 1 – Oct 31 window (both edges inclusive)? */
export function isInSeason(date: Date): boolean {
  const month = date.getUTCMonth() + 1;
  return month >= SEASON_START_MONTH && month <= SEASON_END_MONTH;
}

/**
 * The last moment of the season `date` belongs to.
 *
 * A date before or during the season belongs to that same year's season. A date
 * after it (November or December) belongs to next year's — there is nothing
 * left to schedule in the current one.
 */
export function seasonEnd(date: Date): Date {
  const year = date.getUTCFullYear() + (date.getUTCMonth() + 1 > SEASON_END_MONTH ? 1 : 0);
  // Oct 31 at end of day, so a visit stored at noon on Oct 31 is still inside.
  return new Date(Date.UTC(year, SEASON_END_MONTH - 1, 31, 23, 59, 59));
}

/**
 * The next May 1 strictly after the current season. Used to tell a customer
 * when service resumes and to schedule the "we're back" email.
 *
 * From inside a season this is next year's opening — the current one is already
 * under way. From before a season opens, it is this year's.
 */
export function nextSeasonStart(date: Date): Date {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear() + (month >= SEASON_START_MONTH ? 1 : 0);
  return new Date(Date.UTC(year, SEASON_START_MONTH - 1, 1, 12, 0, 0));
}

/**
 * Drop every out-of-season date, preserving order. The caller keeps whatever
 * survives — a monthly plan booked in September legitimately yields only one
 * or two cleans before the season closes.
 */
export function filterToSeason(dates: Date[]): Date[] {
  return dates.filter(isInSeason);
}
