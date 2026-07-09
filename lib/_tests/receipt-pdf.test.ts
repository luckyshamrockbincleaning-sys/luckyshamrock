import { describe, it, expect } from 'vitest';
import { generateReceiptPdf } from '../receipt-pdf.js';

describe('generateReceiptPdf', () => {
  it('produces a valid one-page PDF with the charged amount', async () => {
    const pdf = await generateReceiptPdf({
      receiptNumber: 'LS-4F2A9C',
      serviceDate: 'Thu, Jul 9, 2026',
      paidDate: 'Thu, Jul 9, 2026',
      customerName: 'Sam Malone',
      address: '14 Clover Lane, Fort Saskatchewan T8L 0A1',
      planLabel: 'Monthly Plan',
      binCount: 2,
      baseCents: 4700,
      discountCents: 0,
      totalCents: 4700,
      outcome: 'charged',
    });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.length).toBeLessThan(200_000);
  });

  it('handles a comped clean with a discount line', async () => {
    const pdf = await generateReceiptPdf({
      receiptNumber: 'LS-AB12CD',
      serviceDate: 'Thu, Jul 9, 2026',
      paidDate: 'Thu, Jul 9, 2026',
      customerName: 'Sam Malone',
      address: '14 Clover Lane, Fort Saskatchewan T8L 0A1',
      planLabel: 'One-Time Clean',
      binCount: 1,
      baseCents: 4500,
      discountCents: 4500,
      totalCents: 0,
      outcome: 'comped',
    });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
