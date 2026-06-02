import { describe, it, expect } from 'vitest';
import { generateVisitDates, generateSeasonalDates, type PickupDay, type Cadence } from '../schedule.js';

// Helpers
function d(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('generateVisitDates', () => {
  describe('one-off (count=1)', () => {
    it('schedules a single visit on (pickup_day + 1) of the following week when start_date is the pickup day', () => {
      // Wed Apr 1, 2026. Pickup = wed. Clean = next thu (apr 9), since today IS pickup day.
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 1,
      });
      expect(dates).toHaveLength(1);
      expect(iso(dates[0]!)).toBe('2026-04-09');
    });

    it('schedules the next clean day after start_date when start_date is earlier in the week', () => {
      // Mon Apr 6, 2026. Pickup = wed. Clean = next thu (apr 9).
      const dates = generateVisitDates({
        startDate: d('2026-04-06'),
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 1,
      });
      expect(iso(dates[0]!)).toBe('2026-04-09');
    });
  });

  describe('recurring (count > 1)', () => {
    it('monthly produces 12 visits, 28 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'), // wednesday
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 12,
      });
      expect(dates).toHaveLength(12);
      expect(iso(dates[0]!)).toBe('2026-04-09'); // next thursday
      expect(iso(dates[1]!)).toBe('2026-05-07'); // +28 days
      expect(iso(dates[2]!)).toBe('2026-06-04');
      expect(iso(dates[11]!)).toBe('2027-02-11'); // 11 * 28 = 308 days after first
    });

    it('bimonthly produces 6 visits, 56 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'bimonthly',
        count: 6,
      });
      expect(dates).toHaveLength(6);
      expect(iso(dates[0]!)).toBe('2026-04-09');
      expect(iso(dates[1]!)).toBe('2026-06-04'); // +56 days
    });

    it('quarterly produces 4 visits, 91 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'quarterly',
        count: 4,
      });
      expect(dates).toHaveLength(4);
      expect(iso(dates[0]!)).toBe('2026-04-09');
      expect(iso(dates[1]!)).toBe('2026-07-09'); // +91 days
    });
  });

  describe('day-of-week alignment', () => {
    const cases: Array<{ pickup: PickupDay; expectedClean: string }> = [
      { pickup: 'monday',    expectedClean: '2026-04-07' }, // Tue Apr 7
      { pickup: 'tuesday',   expectedClean: '2026-04-08' }, // Wed Apr 8
      { pickup: 'wednesday', expectedClean: '2026-04-09' }, // Thu Apr 9
      { pickup: 'thursday',  expectedClean: '2026-04-03' }, // Fri Apr 3
      { pickup: 'friday',    expectedClean: '2026-04-04' }, // Sat Apr 4
    ];

    cases.forEach(({ pickup, expectedClean }) => {
      it(`pickup_day=${pickup} schedules clean on the right weekday starting Apr 1 2026 (wed)`, () => {
        const dates = generateVisitDates({
          startDate: d('2026-04-01'),
          pickupDay: pickup,
          cadence: 'monthly',
          count: 1,
        });
        expect(iso(dates[0]!)).toBe(expectedClean);
      });
    });
  });

  describe('input validation', () => {
    it('throws when count is < 1', () => {
      expect(() =>
        generateVisitDates({
          startDate: d('2026-04-01'),
          pickupDay: 'wednesday',
          cadence: 'monthly',
          count: 0,
        }),
      ).toThrow(/count must be at least 1/i);
    });
  });
});

describe('generateSeasonalDates (Three Wash Season)', () => {
  // Season windows: clean falls in Apr/May, Jul/Aug, Sept/Oct. We anchor each
  // wash to the FIRST clean-day (pickup_day + 1) on/after the 1st of the season's
  // lead month (April, July, September) in the relevant year.
  it('produces 3 washes in season months for a mid-season start', () => {
    // Start Mon Jun 1, 2026, pickup = wednesday (clean = thursday).
    const dates = generateSeasonalDates({ startDate: d('2026-06-01'), pickupDay: 'wednesday', count: 3 });
    expect(dates).toHaveLength(3);
    const months = dates.map((x) => x.getUTCMonth() + 1);
    // remaining seasons this year after June: July(7) and Sept(9), then next April(4)
    expect(months).toEqual([7, 9, 4]);
    // each is a Thursday (clean day for a Wed pickup)
    dates.forEach((x) => expect(x.getUTCDay()).toBe(4));
  });

  it('first wash is the first clean-day on/after the season lead month', () => {
    const dates = generateSeasonalDates({ startDate: d('2026-06-01'), pickupDay: 'wednesday', count: 3 });
    // July 2026: 1st is Wed; first Thursday on/after Jul 1 is Jul 2.
    expect(iso(dates[0]!)).toBe('2026-07-02');
    // Sept 2026: 1st is Tue; first Thursday on/after Sep 1 is Sep 3.
    expect(iso(dates[1]!)).toBe('2026-09-03');
    // April 2027: 1st is Thu; first Thursday on/after Apr 1 is Apr 1.
    expect(iso(dates[2]!)).toBe('2027-04-01');
  });

  it('a start before April yields April, July, September of the same year', () => {
    const dates = generateSeasonalDates({ startDate: d('2026-02-10'), pickupDay: 'monday', count: 3 });
    const months = dates.map((x) => x.getUTCMonth() + 1);
    expect(months).toEqual([4, 7, 9]);
    dates.forEach((x) => expect(x.getUTCDay()).toBe(2)); // Tue clean for Mon pickup
  });

  it('rolls into next year when started after the last season window', () => {
    // Nov 2026 → all three seasons are next year.
    const dates = generateSeasonalDates({ startDate: d('2026-11-15'), pickupDay: 'friday', count: 3 });
    const years = dates.map((x) => x.getUTCFullYear());
    const months = dates.map((x) => x.getUTCMonth() + 1);
    expect(years).toEqual([2027, 2027, 2027]);
    expect(months).toEqual([4, 7, 9]);
  });

  it('throws when count is < 1', () => {
    expect(() => generateSeasonalDates({ startDate: d('2026-06-01'), pickupDay: 'wednesday', count: 0 })).toThrow(/count must be at least 1/i);
  });
});
