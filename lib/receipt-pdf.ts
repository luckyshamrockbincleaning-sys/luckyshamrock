/**
 * PDF receipt for the done email — a one-page, branded record the customer
 * can file or expense. Built with pdf-lib (pure JS, no native deps, safe on
 * Vercel). Best-effort at the call site: a receipt failure must never block
 * the done email.
 *
 * NB: no tax line. Lucky Shamrock is (currently) a small supplier not
 * charging GST. If/when a GST number exists, add the registration number and
 * tax breakdown here — CRA requires both on receipts once registered.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface ReceiptInput {
  receiptNumber: string; // short visit-derived id, e.g. "LS-4F2A9C"
  serviceDate: string; // friendly, e.g. "Thu, Jul 9, 2026"
  paidDate: string; // friendly date of the charge
  customerName: string;
  address: string;
  planLabel: string; // "Monthly Plan" | "One-Time Clean" | "Three Wash Season" …
  binCount: number;
  baseCents: number;
  discountCents: number;
  /**
   * Referral/goodwill credit consumed by this clean. Rendered as its own line
   * so base − discount − credit visibly equals the total paid; without it the
   * receipt's arithmetic would not add up.
   */
  creditCents?: number;
  totalCents: number;
  /** How this clean was settled — drives the line under the total. */
  outcome: 'charged' | 'comped' | 'cash' | 'terminal';
}

const GREEN = rgb(0.114, 0.478, 0.239); // #1d7a3d
const INK = rgb(0.15, 0.2, 0.16);
const MUTED = rgb(0.45, 0.52, 0.46);
const HAIR = rgb(0.85, 0.9, 0.85);

function cad(cents: number): string {
  return `$${(cents / 100).toFixed(2)} CAD`;
}

export async function generateReceiptPdf(r: ReceiptInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 560]); // compact A5-ish portrait
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width } = page.getSize();
  const left = 40;
  const right = width - 40;

  // Header band
  page.drawRectangle({ x: 0, y: 500, width, height: 60, color: GREEN });
  page.drawText('Lucky Shamrock', { x: left, y: 526, size: 20, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Garbage Bin Cleaning · Fort Saskatchewan', { x: left, y: 511, size: 9, font: helv, color: rgb(0.79, 0.91, 0.79) });
  page.drawText('RECEIPT', { x: right - 62, y: 522, size: 13, font: bold, color: rgb(1, 1, 1) });

  let y = 470;
  const label = (text: string, value: string) => {
    page.drawText(text.toUpperCase(), { x: left, y, size: 7.5, font: bold, color: MUTED });
    page.drawText(value, { x: left + 110, y: y - 1, size: 10, font: helv, color: INK });
    y -= 22;
  };
  label('Receipt no.', r.receiptNumber);
  label('Paid', r.paidDate);
  label('Customer', r.customerName);
  label('Service address', r.address);
  label('Service date', r.serviceDate);

  // Line items
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: HAIR });
  y -= 20;
  page.drawText('SERVICE', { x: left, y, size: 7.5, font: bold, color: MUTED });
  page.drawText('AMOUNT', { x: right - 48, y, size: 7.5, font: bold, color: MUTED });
  y -= 18;
  const line = (desc: string, amount: string) => {
    page.drawText(desc, { x: left, y, size: 10, font: helv, color: INK });
    const w = helv.widthOfTextAtSize(amount, 10);
    page.drawText(amount, { x: right - w, y, size: 10, font: helv, color: INK });
    y -= 18;
  };
  const binLabel = r.binCount === 1 ? '1 bin' : `${r.binCount} bins`;
  line(`${r.planLabel} — garbage bin cleaning (${binLabel})`, cad(r.baseCents));
  if ((r.creditCents ?? 0) > 0) {
    line('Referral credit', `-${cad(r.creditCents ?? 0)}`);
  }
  if (r.discountCents > 0) {
    line('Discount', `-${cad(r.discountCents)}`);
  }
  y -= 4;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: HAIR });
  y -= 22;
  page.drawText('TOTAL PAID', { x: left, y, size: 10, font: bold, color: INK });
  const total = cad(r.totalCents);
  const tw = bold.widthOfTextAtSize(total, 13);
  page.drawText(total, { x: right - tw, y: y - 1, size: 13, font: bold, color: GREEN });
  y -= 20;
  const paidByLine =
    r.outcome === 'comped'
      ? 'This clean was on us — no charge.'
      : r.outcome === 'cash'
        ? 'Paid in cash — thank you!'
        : r.outcome === 'terminal'
          ? 'Paid by card in person.'
          : 'Paid by card on file.';
  page.drawText(paidByLine, { x: left, y, size: 9, font: helv, color: MUTED });

  // Footer
  page.drawLine({ start: { x: left, y: 64 }, end: { x: right, y: 64 }, thickness: 1, color: HAIR });
  page.drawText('Lucky Shamrock Garbage Bin Cleaning', { x: left, y: 48, size: 8.5, font: bold, color: MUTED });
  page.drawText('(587) 982-8887 · shea@luckyshamrock.ca · www.luckyshamrock.ca', { x: left, y: 36, size: 8.5, font: helv, color: MUTED });
  page.drawText('Thanks for keeping it fresh.', { x: left, y: 24, size: 8.5, font: helv, color: GREEN });

  return Buffer.from(await doc.save());
}
