import { describe, it, expect } from 'vitest';
import { effectiveStartDate, LAUNCH_DATE_ISO } from '../launch.js';
import { generateVisitDates } from '../schedule.js';

describe('effectiveStartDate (launch floor)', () => {
  it('floors pre-launch dates to the day before launch', () => {
    const early = new Date('2026-07-01T15:00:00Z');
    expect(effectiveStartDate(early).toISOString().slice(0, 10)).toBe('2026-07-22');
  });

  it('passes post-launch dates through unchanged', () => {
    const later = new Date('2026-09-05T15:00:00Z');
    expect(effectiveStartDate(later)).toBe(later);
  });

  it('no clean can land before launch day', () => {
    // Booking well before launch, every pickup day: first clean ≥ July 23.
    for (const pickup of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const) {
      const dates = generateVisitDates({
        startDate: effectiveStartDate(new Date('2026-07-10T12:00:00Z')),
        pickupDay: pickup,
        cadence: 'monthly',
        count: 1,
      });
      expect(dates[0]!.toISOString().slice(0, 10) >= LAUNCH_DATE_ISO).toBe(true);
    }
  });
});
