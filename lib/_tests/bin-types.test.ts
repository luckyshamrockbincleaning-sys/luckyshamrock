import { describe, it, expect } from 'vitest';
import {
  BIN_TYPES,
  BIN_TYPE_LABEL,
  BIN_TYPE_SHORT,
  normalizeBinTypes,
  describeBins,
} from '../bin-types.js';

describe('bin type vocabulary', () => {
  it('is the three bins a Fort Saskatchewan household has', () => {
    expect(BIN_TYPES).toEqual(['garbage', 'organics', 'recycling']);
  });

  it('labels every type for both the form and the route card', () => {
    for (const t of BIN_TYPES) {
      expect(BIN_TYPE_LABEL[t]).toBeTruthy();
      expect(BIN_TYPE_SHORT[t]).toBeTruthy();
    }
  });
});

describe('normalizeBinTypes', () => {
  it('keeps a valid selection', () => {
    expect(normalizeBinTypes(['garbage'])).toEqual(['garbage']);
    expect(normalizeBinTypes(['garbage', 'organics'])).toEqual(['garbage', 'organics']);
  });

  it('sorts into canonical order so bin 1 is always the same bin', () => {
    // Photos and email sections are keyed by position. If the client sent
    // ['recycling','garbage'] the "before/after bin 1" pair would silently
    // mean a different bin than it did last visit.
    expect(normalizeBinTypes(['recycling', 'garbage'])).toEqual(['garbage', 'recycling']);
    expect(normalizeBinTypes(['organics', 'recycling', 'garbage'])).toEqual([
      'garbage',
      'organics',
      'recycling',
    ]);
  });

  it('drops duplicates', () => {
    expect(normalizeBinTypes(['garbage', 'garbage'])).toEqual(['garbage']);
  });

  it('rejects unknown values rather than guessing', () => {
    expect(normalizeBinTypes(['garbage', 'yard-waste'])).toBeNull();
    expect(normalizeBinTypes(['black'])).toBeNull();
  });

  it('rejects an empty selection — every job cleans at least one bin', () => {
    expect(normalizeBinTypes([])).toBeNull();
  });

  it('returns null for anything that is not an array of strings', () => {
    expect(normalizeBinTypes(null)).toBeNull();
    expect(normalizeBinTypes(undefined)).toBeNull();
    expect(normalizeBinTypes('garbage' as unknown as string[])).toBeNull();
    expect(normalizeBinTypes([1, 2] as unknown as string[])).toBeNull();
  });

  it('trims and lowercases what the client sent', () => {
    expect(normalizeBinTypes([' Garbage ', 'ORGANICS'])).toEqual(['garbage', 'organics']);
  });
});

describe('describeBins', () => {
  it('names the bins when we know them', () => {
    expect(describeBins(['garbage'], 1)).toBe('Black bin');
    expect(describeBins(['garbage', 'organics'], 2)).toBe('Black bin + Green bin');
    expect(describeBins(['garbage', 'organics', 'recycling'], 3)).toBe(
      'Black bin + Green bin + Blue bin',
    );
  });

  it('falls back to the count for bookings taken before we asked', () => {
    // Three live subscriptions predate this field. They must still render.
    expect(describeBins(null, 2)).toBe('2 bins');
    expect(describeBins(null, 1)).toBe('1 bin');
    expect(describeBins([], 3)).toBe('3 bins');
  });
});
