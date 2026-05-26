import { describe, it, expect } from 'vitest';
import { isInServiceArea, normalizePostalCode } from '../postal.js';

describe('normalizePostalCode', () => {
  it('uppercases and strips internal whitespace', () => {
    expect(normalizePostalCode('t8l 1a1')).toBe('T8L1A1');
    expect(normalizePostalCode('  t8l1a1  ')).toBe('T8L1A1');
    expect(normalizePostalCode('T8L-1A1')).toBe('T8L1A1');
  });

  it('returns empty string for null-ish input', () => {
    expect(normalizePostalCode('')).toBe('');
    expect(normalizePostalCode('   ')).toBe('');
  });
});

describe('isInServiceArea', () => {
  it('accepts any postal code whose normalized form starts with T8L', () => {
    expect(isInServiceArea('T8L 1A1')).toBe(true);
    expect(isInServiceArea('t8l2b3')).toBe(true);
    expect(isInServiceArea('T8L 9Z9')).toBe(true);
  });

  it('rejects postal codes outside the T8L prefix', () => {
    expect(isInServiceArea('T5J 1A1')).toBe(false); // Edmonton
    expect(isInServiceArea('T6E 2H4')).toBe(false); // Edmonton
    expect(isInServiceArea('K1A 0B1')).toBe(false); // Ottawa
    expect(isInServiceArea('')).toBe(false);
    expect(isInServiceArea('GARBAGE')).toBe(false);
  });

  it('honors SERVICE_POSTAL_PREFIX env override when set', () => {
    const prev = process.env.SERVICE_POSTAL_PREFIX;
    process.env.SERVICE_POSTAL_PREFIX = 'T5J';
    try {
      expect(isInServiceArea('T5J 1A1')).toBe(true);
      expect(isInServiceArea('T8L 1A1')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SERVICE_POSTAL_PREFIX;
      else process.env.SERVICE_POSTAL_PREFIX = prev;
    }
  });
});
