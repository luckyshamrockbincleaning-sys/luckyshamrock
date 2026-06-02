import { addDays, addWeeks, getDay } from 'date-fns';

export type PickupDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
export type Cadence = 'monthly' | 'bimonthly' | 'quarterly' | 'seasonal';

const DAY_INDEX: Record<PickupDay, number> = {
  // date-fns getDay returns 0=Sunday..6=Saturday
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
};

// Rolling cadences (interval in weeks). 'seasonal' is NOT here — it uses
// generateSeasonalDates with fixed Apr/Jul/Sep windows, not a fixed interval.
const CADENCE_WEEKS: Record<Exclude<Cadence, 'seasonal'>, number> = {
  monthly: 4,
  bimonthly: 8,
  quarterly: 13,
};

/**
 * Compute the next calendar date matching `targetDow` strictly AFTER `from`.
 * If `from` itself is the target day, returns 7 days later (the NEXT occurrence).
 */
function nextWeekday(from: Date, targetDow: number): Date {
  const fromDow = getDay(from);
  let delta = targetDow - fromDow;
  if (delta <= 0) delta += 7;
  return addDays(from, delta);
}

export interface GenerateVisitDatesInput {
  startDate: Date;
  pickupDay: PickupDay;
  cadence: Cadence;
  count: number;
}

/**
 * Returns an array of `count` dates starting with the first cleaning day
 * after `startDate`. Cleaning day = customer's pickup day + 1.
 *
 * Subsequent dates are spaced by CADENCE_WEEKS[cadence] weeks each, so the
 * day-of-week stays aligned forever.
 */
export function generateVisitDates(input: GenerateVisitDatesInput): Date[] {
  const { startDate, pickupDay, cadence, count } = input;
  if (count < 1) {
    throw new Error('count must be at least 1');
  }
  if (cadence === 'seasonal') {
    // Seasonal plans use fixed Apr/Jul/Sep windows, not a rolling interval.
    throw new Error('use generateSeasonalDates for the seasonal cadence');
  }

  const pickupDow = DAY_INDEX[pickupDay];
  const nextPickup = nextWeekday(startDate, pickupDow);
  const firstClean = addDays(nextPickup, 1);

  const dates: Date[] = [firstClean];
  const stepWeeks = CADENCE_WEEKS[cadence];
  for (let i = 1; i < count; i++) {
    dates.push(addWeeks(firstClean, i * stepWeeks));
  }
  return dates;
}

// ─────────────────────────────────────────────────────────────────────
// Three Wash Season — fixed seasonal scheduling
//
// Three cleans a year, pinned to seasonal windows rather than a rolling
// interval: spring (Apr/May), mid-summer (Jul/Aug), and fall (Sept/Oct). Each
// wash anchors to the first clean-day (pickup_day + 1) on/after the 1st of the
// season's LEAD month (April, July, September). UTC-based throughout — visits
// are stored date-only.
// ─────────────────────────────────────────────────────────────────────

// 0-based month index of each season's lead month: April, July, September.
const SEASON_LEAD_MONTHS = [3, 6, 8] as const;

export interface GenerateSeasonalDatesInput {
  startDate: Date;
  pickupDay: PickupDay;
  count: number;
}

/** First date with weekday === targetDow on or after `from` (UTC, noon). */
function firstWeekdayOnOrAfter(from: Date, targetDow: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12, 0, 0));
  let delta = targetDow - d.getUTCDay();
  if (delta < 0) delta += 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

/**
 * Returns `count` seasonal clean-days strictly after `startDate`, walking
 * forward through April→July→September windows year over year. Clean day =
 * pickup_day + 1.
 */
export function generateSeasonalDates(input: GenerateSeasonalDatesInput): Date[] {
  const { startDate, pickupDay, count } = input;
  if (count < 1) {
    throw new Error('count must be at least 1');
  }

  const cleanDow = (DAY_INDEX[pickupDay] + 1) % 7;
  const startYear = startDate.getUTCFullYear();
  const dates: Date[] = [];

  for (let year = startYear; dates.length < count; year++) {
    for (const leadMonth of SEASON_LEAD_MONTHS) {
      if (dates.length >= count) break;
      const leadFirst = new Date(Date.UTC(year, leadMonth, 1, 12, 0, 0));
      const wash = firstWeekdayOnOrAfter(leadFirst, cleanDow);
      if (wash.getTime() > startDate.getTime()) {
        dates.push(wash);
      }
    }
  }
  return dates;
}
