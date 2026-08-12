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

const FOOTER_TEXT = '--\nLucky Shamrock Garbage Bin Cleaning · Fort Saskatchewan';

/**
 * Shared branded shell for all outbound HTML email: green 🍀 header, white
 * card, grey footer. Table-based with inline styles only — the lowest common
 * denominator that renders consistently in Gmail, Apple Mail, and Outlook.
 * Body content goes inside the card; don't append FOOTER_HTML to wrapped
 * content (the shell has its own footer).
 */
function brandWrap(bodyHtml: string): string {
  return (
    `<div style="background:#f2f7f2;padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e2ece2">` +
    `<tr><td style="background:#1d7a3d;border-radius:12px 12px 0 0;padding:18px 28px;font-family:Arial,Helvetica,sans-serif">` +
    `<span style="font-size:20px;font-weight:bold;color:#ffffff">🍀 Lucky Shamrock</span>` +
    `<span style="font-size:12px;color:#c9e7c9;display:block;margin-top:2px">Garbage Bin Cleaning · Fort Saskatchewan</span>` +
    `</td></tr>` +
    `<tr><td style="padding:24px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#26332a">` +
    bodyHtml +
    `</td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid #eef3ee;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a998a">` +
    `Lucky Shamrock Garbage Bin Cleaning · Fort Saskatchewan<br>` +
    `(587) 982-8887 · shea@luckyshamrock.ca` +
    `</td></tr>` +
    `</table>` +
    `</td></tr></table>` +
    `</div>`
  );
}

/**
 * Content-IDs for the done email's inline photos. The operator handler
 * attaches the photos with these ids (inline: true) and the HTML references
 * them as <img src="cid:...">. Keep the two in sync via these constants.
 */
export const DONE_BEFORE_PHOTO_CID = 'before-photo';
export const DONE_AFTER_PHOTO_CID = 'after-photo';
export const DONE_WASH_GIF_CID = 'wash-animation';

/**
 * Multi-bin visits (bin 2+) get their own before/after Content-IDs — the wash
 * GIF is only ever generated from bin 1 (see operator-handlers.ts), so every
 * additional bin renders as a plain before/after photo pair. `n` is the
 * 1-indexed bin number (2, 3, ...), never 1 — bin 1 uses the constants above.
 */
export function binBeforePhotoCid(n: number): string {
  return `bin-${n}-before-photo`;
}
export function binAfterPhotoCid(n: number): string {
  return `bin-${n}-after-photo`;
}

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
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>You're confirmed. Your first clean is scheduled for <strong>${escapeHtml(p.firstVisitDate)}</strong>.</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}" style="color:#1d7a3d;font-weight:bold">Manage your booking →</a></p>`,
  );
  return { subject, html, text };
}

export function magicLinkTemplate(p: { manageUrl: string }): RenderedEmail {
  const subject = `Your Lucky Shamrock manage link`;
  const text =
    `Click to manage your booking (link expires in 1 hour):\n\n${p.manageUrl}\n\n` +
    `If you didn't request this, ignore this email.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Click to manage your booking (link expires in 1 hour):</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}" style="color:#1d7a3d;font-weight:bold">${escapeHtml(p.manageUrl)}</a></p>` +
    `<p style="color:#666">If you didn't request this, ignore this email.</p>`,
  );
  return { subject, html, text };
}

export function onOurWayTemplate(p: { name: string }): RenderedEmail {
  const subject = `We're on the way`;
  const text =
    `Hi ${p.name},\n\n` +
    `Lucky Shamrock is heading to your garbage bin now. We'll be in and out — no need to be home.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Lucky Shamrock is heading to your garbage bin now. We'll be in and out — no need to be home.</p>`,
  );
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
   * A per-visit "Lucky washes your bin" GIF is attached inline under
   * DONE_WASH_GIF_CID. Only rendered in the before/after layout — the GIF is
   * generated from those same two photos, so it can't exist without them.
   */
  hasWashGif?: boolean;
  /**
   * Bins beyond the first (bin 1 is covered by hasPhoto/hasBeforePhoto/
   * hasWashGif above). Each entry is bin N (N = index + 2). Same
   * anti-testimonial rule as bin 1: a bin with `hasBefore` but not `hasAfter`
   * renders nothing for that bin.
   */
  extraBins?: Array<{ hasBefore: boolean; hasAfter: boolean }>;
  /**
   * The customer's own referral code, so a happy customer can pass it to a
   * neighbour while the clean bin is still in front of them. Rendered BELOW
   * the star row — never above it. The stars route 4-5★ straight to the Google
   * review page and are the strongest growth lever in this email; the referral
   * ask must not displace them.
   */
  referral?: { code: string; shareUrl: string };
  /**
   * Base URL for the tap-a-star rating links (…/api/rate?v=…&t=…). The
   * template appends &stars=1..5. When set, the star row REPLACES the plain
   * review link — 4-5 star taps forward to the Google review anyway.
   */
  ratingBaseUrl?: string | null;
  /**
   * Payment outcome for this clean — the email doubles as the customer's
   * receipt, since charging happens silently on the operator's Done tap.
   * - charged:  card billed `amountCents` (include the amount).
   * - cash:     collected in cash at the door — no card was touched.
   * - terminal: collected via tap in the Stripe app (in person) — the
   *             customer's card on file was NOT charged.
   * - etransfer: sent by Interac e-transfer — reconciled in the bank, not in
   *             Stripe, and no card was touched.
   * - comped:   fully discounted — explicitly say no charge.
   * - failed:   card declined — tell the customer so the /manage banner isn't
   *             their first hint.
   * - none:     no billing attempted (no card on file / Stripe unconfigured),
   *             or a QR was issued but not yet paid (confirmation lands via
   *             a separate receipt email once the customer pays).
   */
  charge?: { kind: 'charged' | 'cash' | 'terminal' | 'etransfer' | 'comped' | 'failed' | 'none'; amountCents?: number };
  /**
   * An on-the-spot extra for a bin in an unusually bad state. Stated in the
   * email body as well as the attached receipt — plenty of people never open
   * the PDF, and a surprise on a card statement is worse than a sentence here.
   */
  surcharge?: { amountCents: number; reason: string } | null;
}): RenderedEmail {
  const subject = `Your garbage bin is clean`;
  const nextLine = p.nextVisitDate ? `Next clean: ${p.nextVisitDate}.` : `That was your last scheduled clean.`;
  const showBeforeAfter = !!p.hasPhoto && !!p.hasBeforePhoto;
  const showWashGif = !!p.hasWashGif && !!p.hasPhoto;
  const shownExtraBins = (p.extraBins ?? []).filter((b) => b.hasAfter);
  const multiBinSuffix = shownExtraBins.length ? ` (all ${shownExtraBins.length + 1} bins)` : '';
  const photoText = showWashGif
    ? `\n\nYour before-and-after wash animation is attached.${multiBinSuffix}`
    : showBeforeAfter
      ? `\n\nBefore-and-after photos of your bin are attached.${multiBinSuffix}`
      : p.hasPhoto
        ? `\n\nPhoto proof is attached.${multiBinSuffix}`
        : '';
  // Inline styles + table layout: the only combination that renders
  // consistently across Gmail, Apple Mail, and Outlook.
  const photoLabelStyle =
    'font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding-bottom:6px;text-align:center';
  const photoImgStyle = 'width:100%;max-width:340px;border-radius:10px;display:block;margin:0 auto';
  // With the wash GIF, the whole before→foam→after story is ONE image —
  // no separate photos in the body (they'd triple up what the GIF shows).
  const photoHtml = showWashGif
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:340px;margin:16px auto">` +
      `<tr><td><img src="cid:${DONE_WASH_GIF_CID}" alt="Before and after: Lucky giving your bin the full treatment 🍀" style="${photoImgStyle}"></td></tr>` +
      `</table>`
    : showBeforeAfter
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:340px;margin:16px auto">` +
      `<tr><td style="${photoLabelStyle};color:#8a6d3b">Before</td></tr>` +
      `<tr><td><img src="cid:${DONE_BEFORE_PHOTO_CID}" alt="Your bin before cleaning" style="${photoImgStyle}"></td></tr>` +
      `<tr><td style="${photoLabelStyle};color:#1d7a3d;padding-top:12px">After ✨</td></tr>` +
      `<tr><td><img src="cid:${DONE_AFTER_PHOTO_CID}" alt="Your bin after cleaning" style="${photoImgStyle}"></td></tr>` +
      `</table>`
    : p.hasPhoto
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:340px;margin:16px auto">` +
        `<tr><td style="${photoLabelStyle};color:#1d7a3d">Sparkling clean ✨</td></tr>` +
        `<tr><td><img src="cid:${DONE_AFTER_PHOTO_CID}" alt="Your clean bin" style="width:100%;max-width:340px;border-radius:10px;display:block"></td></tr>` +
        `</table>`
      : '';
  // Bin 1 is covered above (photoHtml, possibly as the wash GIF). Bins 2+
  // never get a GIF — always a plain before/after (or after-only) card.
  const extraBinsHtml = shownExtraBins
    .map((bin, i) => {
      const n = i + 2;
      const beforeRows = bin.hasBefore
        ? `<tr><td style="${photoLabelStyle};color:#8a6d3b;padding-top:16px">Bin ${n} — Before</td></tr>` +
          `<tr><td><img src="cid:${binBeforePhotoCid(n)}" alt="Bin ${n} before cleaning" style="${photoImgStyle}"></td></tr>` +
          `<tr><td style="${photoLabelStyle};color:#1d7a3d;padding-top:12px">Bin ${n} — After ✨</td></tr>`
        : `<tr><td style="${photoLabelStyle};color:#1d7a3d;padding-top:16px">Bin ${n} ✨</td></tr>`;
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:340px;margin:0 auto">` +
        beforeRows +
        `<tr><td><img src="cid:${binAfterPhotoCid(n)}" alt="Bin ${n} after cleaning" style="${photoImgStyle}"></td></tr>` +
        `</table>`
      );
    })
    .join('');
  let chargeLine = '';
  if (p.charge?.kind === 'charged' && typeof p.charge.amountCents === 'number') {
    chargeLine = `Your card on file was charged ${formatCad(p.charge.amountCents)}.`;
  } else if (p.charge?.kind === 'cash') {
    chargeLine = `Paid in cash — thank you!`;
  } else if (p.charge?.kind === 'terminal') {
    chargeLine = `Paid by card in person.`;
  } else if (p.charge?.kind === 'etransfer') {
    chargeLine = `Paid by e-transfer — thank you!`;
  } else if (p.charge?.kind === 'comped') {
    chargeLine = `This clean was on us — no charge.`;
  } else if (p.charge?.kind === 'failed') {
    chargeLine = `We couldn't charge your card on file — please update your payment method from your account, and we'll sort out the rest.`;
  }
  const chargeText = chargeLine ? `\n\n${chargeLine}` : '';
  const chargeHtml = chargeLine ? `<p>${escapeHtml(chargeLine)}</p>` : '';
  const sur = p.surcharge && p.surcharge.amountCents > 0 ? p.surcharge : null;
  const surchargeText = sur
    ? `\n\nThis clean included an extra ${formatCad(sur.amountCents)}: ${sur.reason}`
    : '';
  const surchargeHtml = sur
    ? `<p style="background:#FBF0D5;border-radius:8px;padding:10px 12px;margin:0 0 12px">` +
      `<strong>Extra charge: ${formatCad(sur.amountCents)}</strong><br>` +
      `<span style="font-size:14px">${escapeHtml(sur.reason)}</span></p>`
    : '';
  // Star row beats the plain review link when a rating URL exists: one tap
  // records the rating in-place, and happy taps continue on to Google.
  const starsHtml = p.ratingBaseUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto 4px"><tr>` +
      `<td style="font-size:14px;color:#3d4a3a;padding-right:10px">How did we do?</td>` +
      [1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<td><a href="${escapeAttr(`${p.ratingBaseUrl}&stars=${n}`)}" ` +
            `style="text-decoration:none;font-size:26px;line-height:1;padding:0 3px" ` +
            `aria-label="Rate ${n} star${n > 1 ? 's' : ''}">⭐</a></td>`,
        )
        .join('') +
      `</tr></table>` +
      `<p style="text-align:center;font-size:12px;color:#8a998a;margin:0 0 8px">Tap a star — one tap is all it takes.</p>`
    : '';
  const starsText = p.ratingBaseUrl
    ? `\n\nHow did we do? Rate us with one tap: ${p.ratingBaseUrl}&stars=5`
    : '';
  const reviewText = !p.ratingBaseUrl && p.reviewUrl
    ? `\n\nLoved it? Leave us a review: ${p.reviewUrl}`
    : '';
  const reviewHtml = !p.ratingBaseUrl && p.reviewUrl
    ? `<p><a href="${escapeAttr(p.reviewUrl)}">Loved it? Leave us a review →</a></p>`
    : '';
  const referralHtml = p.referral?.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:340px;margin:18px auto 0;border-top:1px solid #eef3ee">` +
      `<tr><td style="font-size:14px;color:#3d4a3a;text-align:center;padding-top:14px">` +
      `Know a neighbour with a bin that needs this? Send them your code — you both get $5.` +
      `</td></tr>` +
      `<tr><td style="text-align:center;padding-top:8px">` +
      `<span style="font-family:monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#1d7a3d">${escapeHtml(p.referral.code)}</span>` +
      `</td></tr>` +
      `<tr><td style="text-align:center;padding-top:6px">` +
      `<a href="${escapeAttr(p.referral.shareUrl)}" style="color:#1d7a3d;font-size:13px">or share your link →</a>` +
      `</td></tr></table>`
    : '';
  const referralText = p.referral?.code
    ? `\n\nKnow a neighbour who needs this? Give them your code ${p.referral.code} — you both get $5. ${p.referral.shareUrl}`
    : '';
  const text =
    `Hi ${p.name},\n\n` +
    `Garbage bin cleaned. ${nextLine}` +
    surchargeText +
    chargeText +
    photoText +
    starsText +
    reviewText +
    referralText +
    `\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Garbage bin cleaned. ${escapeHtml(nextLine)}</p>` +
    surchargeHtml +
    chargeHtml +
    photoHtml +
    extraBinsHtml +
    starsHtml +
    reviewHtml +
    referralHtml,
  );
  return { subject, html, text };
}

/**
 * Refund receipt, triggered by the charge.refunded webhook (refunds are issued
 * from the Stripe dashboard/app, so this email is the customer's only signal).
 */
/**
 * Payment confirmation for a doorstep QR payment, sent when Stripe's
 * checkout.session.completed lands. The done email goes out at Done time with
 * no payment sentence (nobody had paid yet), so this is the customer's only
 * confirmation — and it's what the post-payment page's "your receipt is on its
 * way by email" promises.
 */
/**
 * Sent to a referrer when someone they sent us has had their first clean
 * completed and paid. Deliberately not sent at the friend's booking — nothing
 * is earned until money actually moves.
 */
export function referralEarnedTemplate(p: { name: string; creditCents: number }): RenderedEmail {
  const subject = `You earned $5 — thanks for the referral`;
  const amount = formatCad(p.creditCents);
  const text =
    `Hi ${p.name},\n\n` +
    `Your neighbour's bin is clean — thanks for sending them our way.\n\n` +
    `You've got ${amount} credit waiting. It comes off your next clean automatically, ` +
    `and it never expires.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Your neighbour's bin is clean — thanks for sending them our way. 🍀</p>` +
    `<p>You've got <strong>${amount}</strong> credit waiting. It comes off your next clean ` +
    `automatically, and it never expires.</p>`,
  );
  return { subject, html, text };
}

/**
 * Spring: the cleaning season has reopened and the customer's plan is running
 * again. Sent once per subscriber when the operator opens the season, so the
 * winter gap ends with a message rather than a truck appearing unannounced.
 */
export function seasonStartTemplate(p: { name: string; firstVisitDate: string; manageUrl?: string | null }): RenderedEmail {
  const subject = `We're back — your first clean is ${p.firstVisitDate}`;
  const text =
    `Hi ${p.name},\n\n` +
    `The cleaning season is open again and your plan has picked up where it left off.\n\n` +
    `Your first clean of the season: ${p.firstVisitDate}.\n\n` +
    (p.manageUrl ? `Need a different day? Change it here: ${p.manageUrl}\n\n` : '') +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>The cleaning season is open again 🍀 — your plan has picked up right where it left off.</p>` +
    `<p>Your first clean of the season is <strong>${escapeHtml(p.firstVisitDate)}</strong>.</p>` +
    (p.manageUrl
      ? `<p><a href="${escapeAttr(p.manageUrl)}" style="color:#1d7a3d;font-weight:bold">Need a different day? Change it here →</a></p>`
      : ''),
  );
  return { subject, html, text };
}

export function receiptTemplate(p: { name: string; amountCents: number }): RenderedEmail {
  const subject = `Payment received — ${formatCad(p.amountCents)}`;
  const text =
    `Hi ${p.name},\n\n` +
    `Thanks — we've received your payment of ${formatCad(p.amountCents)} for your garbage bin cleaning.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Thanks — we've received your payment of <strong>${formatCad(p.amountCents)}</strong> for your garbage bin cleaning.</p>` +
    `<p style="color:#666">Questions? Just reply to this email.</p>`,
  );
  return { subject, html, text };
}

export function refundTemplate(p: { name: string; amountCents: number }): RenderedEmail {
  const subject = `Your ${formatCad(p.amountCents)} refund from Lucky Shamrock`;
  const text =
    `Hi ${p.name},\n\n` +
    `We've refunded ${formatCad(p.amountCents)} to your card on file.\n\n` +
    `Depending on your bank, it can take 5–10 business days to show up on your statement.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>We've refunded <strong>${formatCad(p.amountCents)}</strong> to your card on file.</p>` +
    `<p>Depending on your bank, it can take 5–10 business days to show up on your statement.</p>` +
    `<p style="color:#666">Questions? Just reply to this email.</p>`,
  );
  return { subject, html, text };
}

/**
 * Internal heads-up to the operator when a booking lands. Not customer-facing
 * — dense details over polish, everything needed to plan the route at a glance.
 */
export function operatorNewBookingTemplate(p: {
  name: string;
  email: string;
  phone: string | null;
  street: string;
  city: string;
  postalCode: string;
  plan: string;
  binCount: number;
  binLocation: string | null;
  firstVisitDate: string;
}): RenderedEmail {
  const subject = `🍀 New booking: ${p.name} — ${p.plan} — ${p.firstVisitDate}`;
  const rows: Array<[string, string]> = [
    ['Customer', p.name],
    ['Plan', p.plan],
    ['First clean', p.firstVisitDate],
    ['Bins', String(p.binCount)],
    ['Address', [p.street, [p.city, p.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
    ['Email', p.email],
  ];
  if (p.phone) rows.push(['Phone', p.phone]);
  if (p.binLocation) rows.push(['Bin location', p.binLocation]);
  const text =
    `New booking just landed:\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nOpen the route: https://www.luckyshamrock.ca/ops`;
  const html = brandWrap(
    `<p><strong>New booking just landed.</strong></p>` +
    `<table cellpadding="4" cellspacing="0" style="font-size:14px">` +
    rows.map(([k, v]) => `<tr><td style="color:#888;padding-right:12px">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table>` +
    `<p><a href="https://www.luckyshamrock.ca/ops" style="color:#1d7a3d;font-weight:bold">Open the operator dashboard →</a></p>`,
  );
  return { subject, html, text };
}

/**
 * Internal alert: a customer tapped 1-3 stars and left a comment. This is the
 * complaint that would otherwise have been a public review — treat as urgent.
 */
export function operatorFeedbackTemplate(p: {
  name: string;
  email: string;
  phone: string | null;
  rating: number | null;
  comment: string;
  visitDate: string;
}): RenderedEmail {
  const starsLabel = p.rating ? `${p.rating}★` : 'unrated';
  const subject = `⚠️ ${starsLabel} feedback from ${p.name}`;
  const text =
    `${p.name} rated their ${p.visitDate} clean ${starsLabel} and said:\n\n` +
    `"${p.comment}"\n\n` +
    `Reply to them: ${p.email}` +
    (p.phone ? ` · ${p.phone}` : '') +
    `\n\nA quick follow-up now usually turns this around before it becomes a public review.`;
  const html = brandWrap(
    `<p><strong>${escapeHtml(p.name)}</strong> rated their ${escapeHtml(p.visitDate)} clean <strong>${escapeHtml(starsLabel)}</strong> and said:</p>` +
    `<blockquote style="margin:12px 0;padding:12px 16px;background:#f6f3ec;border-left:3px solid #a06b2a">${escapeHtml(p.comment)}</blockquote>` +
    `<p>Reply to them: <a href="mailto:${escapeAttr(p.email)}">${escapeHtml(p.email)}</a>${p.phone ? ` · ${escapeHtml(p.phone)}` : ''}</p>` +
    `<p style="color:#666">A quick follow-up now usually turns this around before it becomes a public review.</p>`,
  );
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
