import { describe, it, expect } from 'vitest';
import { generateVisitDates, type PickupDay, type Cadence } from '../schedule.js';

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
