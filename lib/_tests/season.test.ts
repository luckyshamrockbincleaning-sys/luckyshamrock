import { describe, it, expect } from 'vitest';
import {
  SEASON_START_MONTH,
  SEASON_END_MONTH,
  isInSeason,
  seasonEnd,
  nextSeasonStart,
  filterToSeason,
} from '../season.js';

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('season boundaries', () => {
  it('runs May 1 to Oct 31', () => {
    expect(SEASON_START_MONTH).toBe(5);
    expect(SEASON_END_MONTH).toBe(10);
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
    for (const iso of ['2026-11-15', '2026-12-25', '2027-01-10', '2027-02-28', '2027-03-31']) {
      expect(isInSeason(d(iso))).toBe(false);
    }
  });
});

describe('seasonEnd', () => {
  it('returns Oct 31 of the same year for an in-season date', () => {
    expect(seasonEnd(d('2026-08-21')).toISOString().slice(0, 10)).toBe('2026-10-31');
  });

  it('returns Oct 31 of the SAME year for a date before the season', () => {
    // A February date belongs to the season that opens later that same year.
    expect(seasonEnd(d('2026-02-10')).toISOString().slice(0, 10)).toBe('2026-10-31');
  });

  it('returns Oct 31 of the NEXT year once the season has closed', () => {
    expect(seasonEnd(d('2026-11-20')).toISOString().slice(0, 10)).toBe('2027-10-31');
  });
});

describe('nextSeasonStart', () => {
  it('is May 1 of next year when asked from inside the season', () => {
    expect(nextSeasonStart(d('2026-08-21')).toISOString().slice(0, 10)).toBe('2027-05-01');
  });

  it('is May 1 of the coming year when asked in winter', () => {
    // Standing in November 2026, the next opening is May 2027.
    expect(nextSeasonStart(d('2026-11-20')).toISOString().slice(0, 10)).toBe('2027-05-01');
  });

  it('is May 1 of THIS year when asked before the season opens', () => {
    expect(nextSeasonStart(d('2027-02-10')).toISOString().slice(0, 10)).toBe('2027-05-01');
  });
});

describe('filterToSeason', () => {
  it('drops every out-of-season date', () => {
    const dates = [
      d('2026-08-21'), d('2026-09-18'), d('2026-10-16'),
      d('2026-11-13'), d('2026-12-11'), d('2027-01-08'),
    ];
    expect(filterToSeason(dates).map((x) => x.toISOString().slice(0, 10)))
      .toEqual(['2026-08-21', '2026-09-18', '2026-10-16']);
  });

  it('keeps a date landing exactly on Oct 31', () => {
    expect(filterToSeason([d('2026-10-31')])).toHaveLength(1);
  });

  it('returns an empty array when nothing is in season', () => {
    expect(filterToSeason([d('2026-12-01'), d('2027-01-01')])).toEqual([]);
  });

  it('does not reorder or mutate the input', () => {
    const input = [d('2026-08-21'), d('2026-11-13'), d('2026-09-18')];
    const out = filterToSeason(input);
    expect(input).toHaveLength(3);
    expect(out.map((x) => x.toISOString().slice(0, 10))).toEqual(['2026-08-21', '2026-09-18']);
  });
});
