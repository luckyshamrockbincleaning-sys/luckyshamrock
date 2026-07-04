/**
 * Email templates for Phase 2. Each export is a pure function returning
 * { subject, html, text }. HTML is intentionally minimal — focused on
 * readability across mail clients, not visual design.
 *
 * Templates live in one file because none are big enough to warrant their
 * own. If any grows past ~40 lines, split it out.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const FOOTER_HTML = '<p style="color:#888;font-size:12px;margin-top:32px">Lucky Shamrock Garbage Bin Cleaning · Fort Saskatchewan</p>';
const FOOTER_TEXT = '--\nLucky Shamrock Garbage Bin Cleaning · Fort Saskatchewan';

/**
 * Content-IDs for the done email's inline photos. The operator handler
 * attaches the photos with these ids (inline: true) and the HTML references
 * them as <img src="cid:...">. Keep the two in sync via these constants.
 */
export const DONE_BEFORE_PHOTO_CID = 'before-photo';
export const DONE_AFTER_PHOTO_CID = 'after-photo';

export function bookingConfirmedTemplate(p: {
  name: string;
  firstVisitDate: string;
  manageUrl: string;
}): RenderedEmail {
  const subject = `You're booked with Lucky Shamrock`;
  const text =
    `Hi ${p.name},\n\n` +
    `You're confirmed. Your first clean is scheduled for ${p.firstVisitDate}.\n\n` +
    `Manage your booking: ${p.manageUrl}\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>You're confirmed. Your first clean is scheduled for <strong>${escapeHtml(p.firstVisitDate)}</strong>.</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}">Manage your booking</a></p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function magicLinkTemplate(p: { manageUrl: string }): RenderedEmail {
  const subject = `Your Lucky Shamrock manage link`;
  const text =
    `Click to manage your booking (link expires in 1 hour):\n\n${p.manageUrl}\n\n` +
    `If you didn't request this, ignore this email.\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Click to manage your booking (link expires in 1 hour):</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}">${escapeHtml(p.manageUrl)}</a></p>` +
    `<p style="color:#666">If you didn't request this, ignore this email.</p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function onOurWayTemplate(p: { name: string }): RenderedEmail {
  const subject = `We're on the way`;
  const text =
    `Hi ${p.name},\n\n` +
    `Lucky Shamrock is heading to your garbage bin now. We'll be in and out — no need to be home.\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Lucky Shamrock is heading to your garbage bin now. We'll be in and out — no need to be home.</p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function doneTemplate(p: {
  name: string;
  nextVisitDate: string | null;
  reviewUrl?: string | null;
  hasPhoto?: boolean;
  /**
   * Operator also snapped the bin BEFORE cleaning — renders the side-by-side
   * before/after card. Only honored when hasPhoto (the after shot) is true:
   * a "before" with no "after" would be an anti-testimonial.
   */
  hasBeforePhoto?: boolean;
  /**
   * Payment outcome for this clean — the email doubles as the customer's
   * receipt, since charging happens silently on the operator's Done tap.
   * - charged: card billed `amountCents` (include the amount).
   * - comped:  fully discounted — explicitly say no charge.
   * - failed:  card declined — tell the customer so the /manage banner isn't
   *            their first hint.
   * - none:    no billing attempted (no card on file / Stripe unconfigured).
   */
  charge?: { kind: 'charged' | 'comped' | 'failed' | 'none'; amountCents?: number };
}): RenderedEmail {
  const subject = `Your garbage bin is clean`;
  const nextLine = p.nextVisitDate ? `Next clean: ${p.nextVisitDate}.` : `That was your last scheduled clean.`;
  const showBeforeAfter = !!p.hasPhoto && !!p.hasBeforePhoto;
  const photoText = showBeforeAfter
    ? `\n\nBefore-and-after photos of your bin are attached.`
    : p.hasPhoto
      ? `\n\nPhoto proof is attached.`
      : '';
  // Inline styles + table layout: the only combination that renders
  // consistently across Gmail, Apple Mail, and Outlook.
  const photoLabelStyle =
    'font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding-bottom:6px;text-align:center';
  const photoImgStyle = 'width:100%;max-width:230px;border-radius:10px;display:block;margin:0 auto';
  const photoHtml = showBeforeAfter
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:16px 0">` +
      `<tr>` +
      `<td style="${photoLabelStyle};color:#8a6d3b" width="50%">Before</td>` +
      `<td style="${photoLabelStyle};color:#1d7a3d" width="50%">After ✨</td>` +
      `</tr>` +
      `<tr>` +
      `<td style="padding-right:6px" width="50%"><img src="cid:${DONE_BEFORE_PHOTO_CID}" alt="Your bin before cleaning" style="${photoImgStyle}"></td>` +
      `<td style="padding-left:6px" width="50%"><img src="cid:${DONE_AFTER_PHOTO_CID}" alt="Your bin after cleaning" style="${photoImgStyle}"></td>` +
      `</tr>` +
      `</table>`
    : p.hasPhoto
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:320px;margin:16px 0">` +
        `<tr><td style="${photoLabelStyle};color:#1d7a3d">Sparkling clean ✨</td></tr>` +
        `<tr><td><img src="cid:${DONE_AFTER_PHOTO_CID}" alt="Your clean bin" style="width:100%;max-width:320px;border-radius:10px;display:block"></td></tr>` +
        `</table>`
      : '';
  let chargeLine = '';
  if (p.charge?.kind === 'charged' && typeof p.charge.amountCents === 'number') {
    chargeLine = `Your card on file was charged ${formatCad(p.charge.amountCents)}.`;
  } else if (p.charge?.kind === 'comped') {
    chargeLine = `This clean was on us — no charge.`;
  } else if (p.charge?.kind === 'failed') {
    chargeLine = `We couldn't charge your card on file — please update your payment method from your account, and we'll sort out the rest.`;
  }
  const chargeText = chargeLine ? `\n\n${chargeLine}` : '';
  const chargeHtml = chargeLine ? `<p>${escapeHtml(chargeLine)}</p>` : '';
  const reviewText = p.reviewUrl
    ? `\n\nLoved it? Leave us a review: ${p.reviewUrl}`
    : '';
  const reviewHtml = p.reviewUrl
    ? `<p><a href="${escapeAttr(p.reviewUrl)}">Loved it? Leave us a review →</a></p>`
    : '';
  const text =
    `Hi ${p.name},\n\n` +
    `Garbage bin cleaned. ${nextLine}` +
    chargeText +
    photoText +
    reviewText +
    `\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Garbage bin cleaned. ${escapeHtml(nextLine)}</p>` +
    chargeHtml +
    photoHtml +
    reviewHtml +
    FOOTER_HTML;
  return { subject, html, text };
}

/** Cents → "$35.00" (CAD amounts are always shown with two decimals). */
function formatCad(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (intentionally simple — no general-purpose escape lib)
// ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
