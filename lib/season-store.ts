import { z } from 'zod';
import { getDb } from '../db/client.js';
import { season } from '../db/schema.js';
import type { SeasonCalendar, SeasonWindow } from './season.js';

/**
 * Reads and writes the operator's season dates (the `season` table). The pure
 * rules live in `lib/season.ts`; this is only the I/O, kept apart so the pure
 * module stays importable without a database.
 *
 * The table holds a row per year the operator has touched — a handful of rows
 * ever — so every caller simply loads all of it once per request.
 *
 * Fails OPEN to the default season: a booking must never be lost because this
 * lookup broke (or the code shipped before migration 0016 reached the DB).
 * Saving still fails loudly.
 */
export async function loadSeasonCalendar(): Promise<SeasonCalendar> {
  try {
    return await getDb()
      .select({ year: season.year, start: season.startsOn, end: season.endsOn })
      .from(season);
  } catch (err) {
    console.error('[season] could not load operator season dates; using defaults', err);
    return [];
  }
}

/** Real calendar date as `YYYY-MM-DD` (rejects 2026-02-30). */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => {
  const dt = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === v;
}, 'That is not a real date');

export const seasonWindowSchema = z
  .object({ start: isoDay, end: isoDay })
  .superRefine((v, ctx) => {
    if (v.start.slice(0, 4) !== v.end.slice(0, 4)) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'Opening and closing day must be in the same year' });
    } else if (v.start > v.end) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'Closing day must be on or after the opening day' });
    }
  });

/** Insert or replace one year's season. The year comes from the dates. */
export async function saveSeason(start: string, end: string): Promise<SeasonWindow> {
  const year = Number(start.slice(0, 4));
  await getDb()
    .insert(season)
    .values({ year, startsOn: start, endsOn: end })
    .onConflictDoUpdate({
      target: season.year,
      set: { startsOn: start, endsOn: end, updatedAt: new Date() },
    });
  return { year, start, end };
}
