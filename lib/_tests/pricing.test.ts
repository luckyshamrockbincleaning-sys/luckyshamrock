import { describe, it, expect } from 'vitest';
import { baseChargeCents, finalChargeCents } from '../pricing.js';

describe('baseChargeCents', () => {
  it('one-off (no cadence) is $45 for the first bin plus $12 per extra bin', () => {
    expect(baseChargeCents(null, 1)).toBe(4500);
    expect(baseChargeCents(null, 2)).toBe(5700);
    expect(baseChargeCents(null, 3)).toBe(6900);
  });

  it('monthly is $35 for the first bin plus $12 per extra bin', () => {
    expect(baseChargeCents('monthly', 1)).toBe(3500);
    expect(baseChargeCents('monthly', 2)).toBe(4700);
    expect(baseChargeCents('monthly', 3)).toBe(5900);
  });

  it('seasonal bills $35 for the first bin per wash plus $12 per extra bin', () => {
    expect(baseChargeCents('seasonal', 1)).toBe(3500); // 10500 / 3
    expect(baseChargeCents('seasonal', 2)).toBe(4700);
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
