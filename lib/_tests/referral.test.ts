import { describe, it, expect } from 'vitest';
import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_REWARD_CENTS,
  REFERRAL_CODE_LENGTH,
} from '../referral.js';

describe('REFERRAL_REWARD_CENTS', () => {
  it('is $5 in cents', () => {
    expect(REFERRAL_REWARD_CENTS).toBe(500);
  });
});

describe('generateReferralCode', () => {
  it('returns an uppercase code of the declared length', () => {
    const code = generateReferralCode();
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(code).toBe(code.toUpperCase());
  });

  it('never emits visually ambiguous characters', () => {
    // 0/O and 1/I/L get misheard over a fence and mistyped from a sticker.
    for (let i = 0; i < 500; i++) {
      expect(generateReferralCode()).not.toMatch(/[01OIL]/);
    }
  });

  it('draws from the full alphabet and does not return a constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateReferralCode());
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('normalizeReferralCode', () => {
  it('uppercases and strips spaces and dashes so "k7m2-qx" matches', () => {
    expect(normalizeReferralCode(' k7m2-qx ')).toBe('K7M2QX');
  });

  it('returns an empty string for null-ish input', () => {
    expect(normalizeReferralCode('')).toBe('');
    expect(normalizeReferralCode(undefined as unknown as string)).toBe('');
  });
});
