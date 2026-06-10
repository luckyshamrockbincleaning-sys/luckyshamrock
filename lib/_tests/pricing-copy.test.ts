import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pricingCopy = readFileSync(new URL('../../components-mid.jsx', import.meta.url), 'utf8');
const bookingCopy = readFileSync(new URL('../../components-booking.jsx', import.meta.url), 'utf8');

describe('public pricing copy', () => {
  it('describes plan prices as first-bin prices and extra bins as $12 each', () => {
    expect(pricingCopy).toContain('unit: "per first garbage bin"');
    expect(pricingCopy).toContain('unit: "per first garbage bin · monthly"');
    expect(pricingCopy).toContain('unit: "per first garbage bin · 3 washes/yr"');
    // Extra-bin price now comes from the single source (pricing.js → P); the
    // dollar value itself is guarded against the server by pricing-sync.test.ts.
    expect(pricingCopy).toContain('Extra bins are $${P.extraBinPerClean} each per clean.');

    expect(pricingCopy).not.toMatch(/10% off/i);
    expect(pricingCopy).not.toContain('unit: "per garbage bin"');
    expect(pricingCopy).not.toContain('unit: "per garbage bin · monthly"');
    expect(pricingCopy).not.toContain('unit: "per garbage bin · 3 washes/yr"');
  });

  it('keeps booking payment timing copy at zero due before service', () => {
    expect(bookingCopy).toContain('<span>Charged today</span>');
    expect(bookingCopy).toContain('<span>$0</span>');
    expect(bookingCopy).toContain('Card saved before confirmation — charged only after each clean.');
    expect(bookingCopy).toContain('Math.max(0, bins - 1) * P.extraBinPerClean');

    expect(bookingCopy).not.toContain('<span>Due today</span>');
    expect(bookingCopy).not.toMatch(/deep treatment/i);
  });
});
