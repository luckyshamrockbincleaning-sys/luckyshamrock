import { describe, it, expect } from 'vitest';
import { baseChargeCents, finalChargeCents } from '../pricing.js';

describe('baseChargeCents', () => {
  it('one-off (no cadence) is $45 × bins', () => {
    expect(baseChargeCents(null, 1)).toBe(4500);
    expect(baseChargeCents(null, 2)).toBe(9000);
  });

  it('monthly is $35 per clean × bins', () => {
    expect(baseChargeCents('monthly', 1)).toBe(3500);
    expect(baseChargeCents('monthly', 3)).toBe(10500);
  });

  it('seasonal bills 1/3 of $105 per wash (≈$35) × bins', () => {
    expect(baseChargeCents('seasonal', 1)).toBe(3500); // 10500 / 3
    expect(baseChargeCents('seasonal', 2)).toBe(7000);
  });

  it('defaults a missing/zero bin count to 1', () => {
    expect(baseChargeCents('monthly', 0)).toBe(3500);
  });
});

describe('finalChargeCents', () => {
  it('subtracts the discount', () => {
    expect(finalChargeCents(3500, 500)).toBe(3000);
  });

  it('clamps discount to the base (never negative)', () => {
    expect(finalChargeCents(3500, 9999)).toBe(0);
  });

  it('treats a missing/negative discount as zero', () => {
    expect(finalChargeCents(3500, 0)).toBe(3500);
    expect(finalChargeCents(3500, -100)).toBe(3500);
  });
});
