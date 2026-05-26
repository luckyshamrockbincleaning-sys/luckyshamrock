import { addDays, addWeeks, getDay } from 'date-fns';

export type PickupDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
export type Cadence = 'monthly' | 'bimonthly' | 'quarterly';

const DAY_INDEX: Record<PickupDay, number> = {
  // date-fns getDay returns 0=Sunday..6=Saturday
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
};

const CADENCE_WEEKS: Record<Cadence, number> = {
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
