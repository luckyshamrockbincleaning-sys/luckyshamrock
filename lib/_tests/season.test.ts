import { describe, it, expect } from 'vitest';
import {
  isInSeason,
  seasonEnd,
  seasonFor,
  upcomingSeason,
  nextSeasonStart,
  filterToSeason,
  seasonLabel,
  seasonSummary,
  type SeasonCalendar,
} from '../season.js';

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

// The operator closed 2026 early and opened 2027 late.
const CAL: SeasonCalendar = [
  { year: 2026, start: '2026-05-01', end: '2026-10-16' },
  { year: 2027, start: '2027-05-15', end: '2027-10-31' },
];

describe('season boundaries (defaults)', () => {
  it('a year with no operator dates runs May 1 to Oct 31', () => {
    expect(seasonFor(2028)).toEqual({ year: 2028, start: '2028-05-01', end: '2028-10-31' });
  });

  it('includes both edges of the season', () => {
    expect(isInSeason(d('2026-05-01'))).toBe(true);
    expect(isInSeason(d('2026-10-31'))).toBe(true);
  });

  it('excludes the day either side', () => {
    expect(isInSeason(d('2026-04-30'))).toBe(false);
    expect(isInSeason(d('2026-11-01'))).toBe(false);
  });

  it('excludes deep winter', () => {
    for (const day of ['2026-11-15', '2026-12-25', '2027-01-10', '2027-02-28', '2027-03-31']) {
      expect(isInSeason(d(day))).toBe(false);
    }
  });

  it('treats a date-only row (UTC midnight) the same as UTC noon', () => {
    expect(isInSeason(new Date('2026-10-31'))).toBe(true);
    expect(isInSeason(new Date('2026-11-01'))).toBe(false);
  });
});

describe('operator-set seasons', () => {
  it('uses the operator dates for a year that has them', () => {
    expect(seasonFor(2026, CAL).end).toBe('2026-10-16');
  });

  it('includes the operator closing day and excludes the day after', () => {
    expect(isInSeason(d('2026-10-16'), CAL)).toBe(true);
    expect(isInSeason(d('2026-10-17'), CAL)).toBe(false);
    expect(isInSeason(d('2026-10-31'), CAL)).toBe(false);
  });

  it('honours a late opening', () => {
    expect(isInSeason(d('2027-05-14'), CAL)).toBe(false);
    expect(isInSeason(d('2027-05-15'), CAL)).toBe(true);
  });

  it('falls back to the default for years the operator has not set', () => {
    expect(isInSeason(d('2028-05-01'), CAL)).toBe(true);
    expect(isInSeason(d('2028-10-31'), CAL)).toBe(true);
  });
});

describe('seasonEnd', () => {
  it('returns Oct 31 of the same year for an in-season date', () => {
    expect(iso(seasonEnd(d('2026-08-21')))).toBe('2026-10-31');
  });

  it('returns Oct 31 of the SAME year for a date before the season', () => {
    // A February date belongs to the season that opens later that same year.
    expect(iso(seasonEnd(d('2026-02-10')))).toBe('2026-10-31');
  });

  it('returns Oct 31 of the NEXT year once the season has closed', () => {
    expect(iso(seasonEnd(d('2026-11-20')))).toBe('2027-10-31');
  });

  it('uses the operator closing day, at end of day', () => {
    const end = seasonEnd(d('2026-08-21'), CAL);
    expect(end.toISOString()).toBe('2026-10-16T23:59:59.000Z');
    expect(d('2026-10-16') <= end).toBe(true);
  });

  it('rolls to next year the day after an early close', () => {
    expect(iso(seasonEnd(d('2026-10-20'), CAL))).toBe('2027-10-31');
  });
});

describe('upcomingSeason', () => {
  it('is this year while the season is open or yet to open', () => {
    expect(upcomingSeason(d('2026-02-10'), CAL).year).toBe(2026);
    expect(upcomingSeason(d('2026-10-16'), CAL).year).toBe(2026);
  });

  it('is next year once this year has closed', () => {
    expect(upcomingSeason(d('2026-10-17'), CAL)).toEqual(CAL[1]);
  });
});

describe('nextSeasonStart', () => {
  it('is May 1 of next year when asked from inside the season', () => {
    expect(iso(nextSeasonStart(d('2026-08-21')))).toBe('2027-05-01');
  });

  it('is May 1 of the coming year when asked in winter', () => {
    // Standing in November 2026, the next opening is May 2027.
    expect(iso(nextSeasonStart(d('2026-11-20')))).toBe('2027-05-01');
  });

  it('is May 1 of THIS year when asked before the season opens', () => {
    expect(iso(nextSeasonStart(d('2027-02-10')))).toBe('2027-05-01');
  });

  it('uses the operator opening day', () => {
    expect(iso(nextSeasonStart(d('2026-10-20'), CAL))).toBe('2027-05-15');
    expect(iso(nextSeasonStart(d('2027-05-10'), CAL))).toBe('2027-05-15');
  });
});

describe('filterToSeason', () => {
  it('drops every out-of-season date', () => {
    const dates = [
      d('2026-08-21'), d('2026-09-18'), d('2026-10-16'),
      d('2026-11-13'), d('2026-12-11'), d('2027-01-08'),
    ];
    expect(filterToSeason(dates).map(iso)).toEqual(['2026-08-21', '2026-09-18', '2026-10-16']);
  });

  it('keeps a date landing exactly on Oct 31', () => {
    expect(filterToSeason([d('2026-10-31')])).toHaveLength(1);
  });

  it('drops dates after an early operator close', () => {
    expect(filterToSeason([d('2026-10-16'), d('2026-10-20')], CAL).map(iso)).toEqual(['2026-10-16']);
  });

  it('returns an empty array when nothing is in season', () => {
    expect(filterToSeason([d('2026-12-01'), d('2027-01-01')])).toEqual([]);
  });

  it('does not reorder or mutate the input', () => {
    const input = [d('2026-08-21'), d('2026-11-13'), d('2026-09-18')];
    const out = filterToSeason(input);
    expect(input).toHaveLength(3);
    expect(out.map(iso)).toEqual(['2026-08-21', '2026-09-18']);
  });
});

describe('seasonLabel', () => {
  it('reads as customer copy', () => {
    expect(seasonLabel(seasonFor(2028))).toBe('May 1 – October 31');
    expect(seasonLabel(CAL[0]!)).toBe('May 1 – October 16');
  });
});

describe('seasonSummary', () => {
  it('describes this season while it is open', () => {
    const s = seasonSummary(d('2026-10-08'), CAL);
    expect(s).toMatchObject({
      in_season: true,
      label: 'May 1 – October 16',
      start: '2026-05-01',
      end: '2026-10-16',
      next_start: '2027-05-15',
    });
    expect(s.windows.map((w) => w.year)).toEqual([2026, 2027]);
  });

  it('describes next season once this one has closed', () => {
    const s = seasonSummary(d('2026-10-20'), CAL);
    expect(s).toMatchObject({ in_season: false, label: 'May 15 – October 31', start: '2027-05-15' });
  });
});
