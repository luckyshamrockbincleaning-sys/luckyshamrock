import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baseChargeCents } from '../pricing.js';

// The client price source (pricing.js → window.LS_PRICING) must never drift from
// the server's lib/pricing.ts — the project has been bitten by price-copy drift.
// Parse the literal dollar values out of pricing.js (no eval) and compare to the
// server's computed cents.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'pricing.js'), 'utf8');
function priceOf(key: string): number {
  const m = src.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
  if (!m) throw new Error(`pricing.js is missing key "${key}"`);
  return Number(m[1]);
}
const P = {
  oneoff: priceOf('oneoff'),
  monthly: priceOf('monthly'),
  seasonalSeason: priceOf('seasonalSeason'),
  seasonalPerWash: priceOf('seasonalPerWash'),
  extraBinPerClean: priceOf('extraBinPerClean'),
};

describe('pricing.js (client) mirrors lib/pricing.ts (server)', () => {
  it('one-off / monthly / seasonal-per-wash dollars match server cents', () => {
    expect(P.oneoff * 100).toBe(baseChargeCents(null, 1));
    expect(P.monthly * 100).toBe(baseChargeCents('monthly', 1));
    expect(P.seasonalPerWash * 100).toBe(baseChargeCents('seasonal', 1));
  });

  it('extra-bin dollars match the server per-bin delta', () => {
    expect(P.extraBinPerClean * 100).toBe(baseChargeCents('monthly', 2) - baseChargeCents('monthly', 1));
  });

  it('the seasonal season total is three washes', () => {
    expect(P.seasonalSeason).toBe(P.seasonalPerWash * 3);
  });
});
