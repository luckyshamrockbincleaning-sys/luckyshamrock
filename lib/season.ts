/**
 * The cleaning season.
 *
 * Bin cleaning is a pressure-washing business in Fort Saskatchewan — it cannot
 * run through an Alberta winter, and no visit may ever be scheduled outside the
 * season.
 *
 * The operator sets each year's opening and closing day from /ops (the
 * `season` table, loaded by `lib/season-store.ts`), because the weather decides
 * them, not the calendar. A year with no row falls back to **May 1 to
 * October 31**. Every function here takes that list of operator-set years as a
 * `SeasonCalendar`; leaving it out means "all defaults".
 *
 * This module exists because visit generation was originally season-blind:
 * booking a monthly plan produced 12 visits at a flat 28-day interval, which
 * happily scheduled cleans through January. Worse, the /api/me top-up would
 * regenerate them after any manual cleanup, because it only counted visits
 * rather than checking whether they were possible. Two real customers
 * (2026-08-05 and 2026-08-07) each had 7 winter cleans booked before this
 * was caught.
 *
 * Dates are compared by their UTC calendar day. Visit rows are stored
 * date-only (read back at UTC midnight) or generated at UTC noon; both keep
 * the calendar day stable either side of a Mountain-Time offset.
 */

/** One year's season, both edges inclusive, as `YYYY-MM-DD`. */
export interface SeasonWindow {
  year: number;
  start: string;
  end: string;
}

/** The operator-set years. A year missing from the list uses the default. */
export type SeasonCalendar = readonly SeasonWindow[];

/** `MM-DD` of the default opening and closing day. */
export const DEFAULT_SEASON_START = '05-01';
export const DEFAULT_SEASON_END = '10-31';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dayISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The season for `year`: the operator's dates if set, else May 1 – Oct 31. */
export function seasonFor(year: number, calendar: SeasonCalendar = []): SeasonWindow {
  const set = calendar.find((w) => w.year === year);
  if (set) return set;
  return { year, start: `${year}-${DEFAULT_SEASON_START}`, end: `${year}-${DEFAULT_SEASON_END}` };
}

/** Is this date inside its year's season (both edges inclusive)? */
export function isInSeason(date: Date, calendar: SeasonCalendar = []): boolean {
  const day = dayISO(date);
  const w = seasonFor(date.getUTCFullYear(), calendar);
  return day >= w.start && day <= w.end;
}

/**
 * The season `date` is looking ahead to: this year's if it hasn't closed yet,
 * otherwise next year's. A February date belongs to the season that opens later
 * that year; a November date to next year's.
 */
export function upcomingSeason(date: Date, calendar: SeasonCalendar = []): SeasonWindow {
  const year = date.getUTCFullYear();
  const w = seasonFor(year, calendar);
  return dayISO(date) > w.end ? seasonFor(year + 1, calendar) : w;
}

/**
 * The last moment of the season `date` belongs to — end of day on the closing
 * day, so a visit stored on that day is still inside.
 */
export function seasonEnd(date: Date, calendar: SeasonCalendar = []): Date {
  return new Date(`${upcomingSeason(date, calendar).end}T23:59:59Z`);
}

/**
 * The next opening day strictly after the current season. Used to tell a
 * customer when service resumes.
 *
 * From inside a season (or after it) this is next year's opening — the current
 * one is already under way. From before a season opens, it is this year's.
 */
export function nextSeasonStart(date: Date, calendar: SeasonCalendar = []): Date {
  const year = date.getUTCFullYear();
  const thisYear = seasonFor(year, calendar);
  const w = dayISO(date) < thisYear.start ? thisYear : seasonFor(year + 1, calendar);
  return new Date(`${w.start}T12:00:00Z`);
}

/**
 * Drop every out-of-season date, preserving order. The caller keeps whatever
 * survives — a monthly plan booked in September legitimately yields only one
 * or two cleans before the season closes.
 */
export function filterToSeason(dates: Date[], calendar: SeasonCalendar = []): Date[] {
  return dates.filter((d) => isInSeason(d, calendar));
}

/** "May 1 – October 16", for customer-facing copy. */
export function seasonLabel(w: SeasonWindow): string {
  const fmt = (iso: string) => {
    const [, m, d] = iso.split('-').map(Number);
    return `${MONTHS[m! - 1]} ${d}`;
  };
  return `${fmt(w.start)} – ${fmt(w.end)}`;
}

/**
 * What a customer-facing page needs to know about the season, as sent by
 * `GET /api/book` and in `GET /api/me`. `start`/`end`/`label` describe the
 * upcoming season (this year's until it closes, then next year's); `windows`
 * covers this year and next so a calendar spanning New Year can grey out days.
 */
export function seasonSummary(now: Date, calendar: SeasonCalendar = []) {
  const w = upcomingSeason(now, calendar);
  const year = now.getUTCFullYear();
  return {
    in_season: isInSeason(now, calendar),
    label: seasonLabel(w),
    start: w.start,
    end: w.end,
    next_start: dayISO(nextSeasonStart(now, calendar)),
    windows: [seasonFor(year, calendar), seasonFor(year + 1, calendar)],
  };
}
