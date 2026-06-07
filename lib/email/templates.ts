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

const FOOTER_HTML = '<p style="color:#888;font-size:12px;margin-top:32px">Lucky Shamrock Bin Cleaning · Fort Saskatchewan</p>';
const FOOTER_TEXT = '--\nLucky Shamrock Bin Cleaning · Fort Saskatchewan';

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
}): RenderedEmail {
  const subject = `Your garbage bin is clean`;
  const nextLine = p.nextVisitDate ? `Next clean: ${p.nextVisitDate}.` : `That was your last scheduled clean.`;
  const photoText = p.hasPhoto ? `\n\nPhoto proof is attached.` : '';
  const photoHtml = p.hasPhoto ? `<p>Photo proof is attached.</p>` : '';
  const reviewText = p.reviewUrl
    ? `\n\nLoved it? Leave us a review: ${p.reviewUrl}`
    : '';
  const reviewHtml = p.reviewUrl
    ? `<p><a href="${escapeAttr(p.reviewUrl)}">Loved it? Leave us a review →</a></p>`
    : '';
  const text =
    `Hi ${p.name},\n\n` +
    `Garbage bin cleaned. ${nextLine}` +
    photoText +
    reviewText +
    `\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Garbage bin cleaned. ${escapeHtml(nextLine)}</p>` +
    photoHtml +
    reviewHtml +
    FOOTER_HTML;
  return { subject, html, text };
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
