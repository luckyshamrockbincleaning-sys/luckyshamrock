/**
 * Operator endpoint handlers, consolidated into one module.
 *
 * Vercel Hobby allows at most 12 serverless functions per deployment. To keep
 * all operator routes in a single function, the real handler logic lives here
 * as named exports and the single-segment route `api/operator/[action].ts`
 * dispatches to them. (A catch-all `[...path]` 404'd in the Vercel runtime — see
 * that file's header.) Each is a plain (req, res) handler — testable directly,
 * no routing layer in the way.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { and, eq, gt, inArray, asc, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, subscription, visit, payment } from '../db/schema.js';
import {
  getOperatorSession,
  signOperatorCookie,
  formatOperatorCookieHeader,
  verifyOperatorPassword,
  operatorTodayISO,
  toOperatorVisit,
} from './operator.js';
import { normalizePostalCode } from './postal.js';
import { sendAndLog } from './notifications.js';
import {
  onOurWayTemplate,
  doneTemplate,
  DONE_BEFORE_PHOTO_CID,
  DONE_AFTER_PHOTO_CID,
  DONE_WASH_GIF_CID,
  binBeforePhotoCid,
  binAfterPhotoCid,
} from './email/templates.js';
import { generateWashGif } from './wash-gif.js';
import { LEPRECHAUN_SPRITES } from './leprechaun-sprites.js';
import { generateReceiptPdf } from './receipt-pdf.js';
import { signRatingToken } from './rating-token.js';
import { isStripeConfigured } from './stripe.js';
import { chargeOffSession, createDoorstepCheckoutSession } from './billing.js';
import { baseChargeCents, finalChargeCents } from './pricing.js';
import { formatFriendlyDate } from './dates.js';
import type { Cadence } from './schedule.js';
import type { EmailAttachment } from './email.js';
import { isPlaceholderEmail } from './walkup-email.js';
import QRCode from 'qrcode';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONABLE_VISIT_STATUSES: Array<'scheduled' | 'heading_there'> = ['scheduled', 'heading_there'];
const MAX_CLEAN_PHOTO_BYTES = 5 * 1024 * 1024;
const CLEAN_PHOTO_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const loginSchema = z.object({ password: z.string().min(1) });
const noteSchema = z.object({ text: z.string().trim().min(1).max(1000) });
const actSchema = z
  .object({ id: z.string().min(1), op: z.enum(['notify', 'done', 'skip', 'note', 'retry']) })
  .passthrough(); // keep `text` through for the note op
const cleanPhotoSchema = z.object({
  filename: z.string().trim().min(1).max(160).optional(),
  mime_type: z.string().trim().min(1).max(80),
  content_base64: z.string().trim().min(1),
});
const donePaymentSchema = z.object({
  payment_method: z.enum(['card_on_file', 'cash', 'terminal', 'qr']).default('card_on_file'),
  // Operator override for doorstep deals ("$40 cash"). Server still floors it
  // at 0 and ignores absurd values; the default comes from lib/pricing.ts.
  amount_cents: z.number().int().min(0).max(100_000).optional(),
});
const newJobSchema = z
  .object({
    street: z.string().trim().min(1).max(200),
    postal_code: z.string().trim().min(1).max(10),
    bin_count: z.number().int().min(1).max(3).default(1),
    email: z.string().trim().toLowerCase().email().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    // "Come back in two weeks" deals struck at the door. Omitted = today,
    // which stays the common walk-up case.
    scheduled_for: z.string().regex(DATE_RE, 'scheduled_for must be YYYY-MM-DD').optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.scheduled_for) return;
    if (!parseDateOnlyUtcNoon(data.scheduled_for)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scheduled_for must be a real calendar date',
        path: ['scheduled_for'],
      });
      return;
    }
    // A visit dated before today would never surface again: `today` only
    // matches the current date and `upcoming` only looks forward, so a
    // fat-fingered past date silently creates work nobody can see.
    const today = operatorTodayISO();
    if (data.scheduled_for < today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scheduled_for cannot be in the past',
        path: ['scheduled_for'],
      });
    }
    // Same reasoning in the other direction — a typo'd year (2036) would
    // park the job a decade out where nobody would ever look for it.
    if (data.scheduled_for > isoPlusDays(today, 365)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scheduled_for cannot be more than a year out',
        path: ['scheduled_for'],
      });
    }
    // NB: Sundays are deliberately allowed here, unlike the customer-facing
    // booking form. This endpoint already trusts the operator over the system
    // (it skips the service-area gate too) — they're standing at the bin
    // making the deal, so the day is their call.
  });

// Columns selected for the operator stop view (customer + subscription join).
const stopColumns = {
  id: visit.id,
  scheduledFor: visit.scheduledFor,
  status: visit.status,
  paymentStatus: visit.paymentStatus,
  notes: visit.notes,
  headingThereAt: visit.headingThereAt,
  doneAt: visit.doneAt,
  name: customer.name,
  phone: customer.phone,
  street: customer.street,
  city: customer.city,
  postalCode: customer.postalCode,
  binLocation: customer.binLocation,
  // One-offs store bin_count on the visit; recurring derive it from the
  // subscription. COALESCE picks whichever is present.
  binCount: sql<number | null>`coalesce(${visit.binCount}, ${subscription.binCount})`,
} as const;

function isActionableVisitStatus(status: string): boolean {
  return ACTIONABLE_VISIT_STATUSES.includes(status as 'scheduled' | 'heading_there');
}

/**
 * Parse a YYYY-MM-DD string at UTC noon, rejecting non-dates that still match
 * the regex (2026-02-31). Noon keeps the calendar day stable either side of a
 * Mountain-Time offset. Mirrors the same helper in lib/validation.ts.
 */
function parseDateOnlyUtcNoon(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

function isoPlusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parsePhotoAttachment(
  input: unknown,
  field: string,
): { ok: true; attachment: EmailAttachment | null } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, attachment: null };
  const parsed = cleanPhotoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: `${field} is invalid` };

  const ext = CLEAN_PHOTO_MIME_TO_EXT[parsed.data.mime_type];
  if (!ext) return { ok: false, message: `${field} must be a JPEG, PNG, or WebP image` };

  const base64 = parsed.data.content_base64.replace(/\s/g, '');
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, message: `${field} content must be base64` };
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) return { ok: false, message: `${field} is empty` };
  if (bytes.length > MAX_CLEAN_PHOTO_BYTES) {
    return { ok: false, message: `${field} must be 5 MB or smaller` };
  }

  const fallbackFilename = field.includes('before') ? `before-bin.${ext}` : `clean-bin.${ext}`;
  return {
    ok: true,
    attachment: {
      filename: parsed.data.filename?.replace(/[^A-Za-z0-9._-]/g, '_') || fallbackFilename,
      contentType: parsed.data.mime_type,
      contentBase64: base64,
    },
  };
}

interface PhotoPair {
  before: EmailAttachment | null;
  after: EmailAttachment | null;
}

const MAX_PHOTO_PAIRS = 3; // matches the bin_count ceiling (booking + walk-up job forms)

/**
 * A visit's Done photos, one pair per bin. Preferred shape is
 * `photos: [{before?, after?}, ...]`. Falls back to the legacy single-bin
 * `before_photo`/`clean_photo` fields so older /ops clients (and every
 * existing single-bin test) keep working unchanged. `photos`, when present,
 * always wins — a caller sending both is almost certainly a bug, not an
 * intentional mix.
 */
function parsePhotoPairs(body: any): { ok: true; pairs: PhotoPair[] } | { ok: false; message: string } {
  if (Array.isArray(body?.photos)) {
    if (body.photos.length === 0) return { ok: false, message: 'photos must not be empty' };
    if (body.photos.length > MAX_PHOTO_PAIRS) return { ok: false, message: `photos supports at most ${MAX_PHOTO_PAIRS} bins` };
    const pairs: PhotoPair[] = [];
    for (let i = 0; i < body.photos.length; i++) {
      const entry = body.photos[i];
      const before = parsePhotoAttachment(entry?.before, `photos[${i}].before`);
      if (!before.ok) return before;
      const after = parsePhotoAttachment(entry?.after, `photos[${i}].after`);
      if (!after.ok) return after;
      pairs.push({ before: before.attachment, after: after.attachment });
    }
    return { ok: true, pairs };
  }
  const cleanPhoto = parsePhotoAttachment(body?.clean_photo, 'clean_photo');
  if (!cleanPhoto.ok) return cleanPhoto;
  const beforePhoto = parsePhotoAttachment(body?.before_photo, 'before_photo');
  if (!beforePhoto.ok) return beforePhoto;
  return { ok: true, pairs: [{ before: beforePhoto.attachment, after: cleanPhoto.attachment }] };
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/login
// ─────────────────────────────────────────────────────────────────────
export async function handleLogin(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!verifyOperatorPassword(parsed.data.password)) {
    res.status(401).json({ status: 'invalid_password', message: 'Incorrect password.' });
    return;
  }
  try {
    const token = await signOperatorCookie();
    res.setHeader('Set-Cookie', formatOperatorCookieHeader(token));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[operator/login] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/operator/today (?date=YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────
export async function handleToday(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  try {
    const q = req.query.date;
    const targetISO = typeof q === 'string' && DATE_RE.test(q) ? q : operatorTodayISO();
    const targetDate = new Date(`${targetISO}T00:00:00Z`);

    const db = getDb();
    const rows = await db
      .select(stopColumns)
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .leftJoin(subscription, eq(visit.subscriptionId, subscription.id))
      .where(and(eq(visit.scheduledFor, targetDate), inArray(visit.status, ACTIONABLE_VISIT_STATUSES)))
      .orderBy(asc(customer.name));

    res.status(200).json({ status: 'ok', date: targetISO, visits: rows.map(toOperatorVisit) });
  } catch (err) {
    console.error('[operator/today] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/operator/upcoming (?date=YYYY-MM-DD anchor)
// ─────────────────────────────────────────────────────────────────────
export async function handleUpcoming(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  try {
    const q = req.query.date;
    const anchorISO = typeof q === 'string' && DATE_RE.test(q) ? q : operatorTodayISO();
    const anchor = new Date(`${anchorISO}T00:00:00Z`);

    const db = getDb();
    const rows = await db
      .select(stopColumns)
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .leftJoin(subscription, eq(visit.subscriptionId, subscription.id))
      .where(
        and(
          gt(visit.scheduledFor, anchor),
          inArray(visit.status, ACTIONABLE_VISIT_STATUSES),
        ),
      )
      .orderBy(asc(visit.scheduledFor), asc(customer.name));

    res.status(200).json({ status: 'ok', visits: rows.map(toOperatorVisit) });
  } catch (err) {
    console.error('[operator/upcoming] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/job — create a job for a walk-up customer
// ─────────────────────────────────────────────────────────────────────
/**
 * The neighbour who flags the truck down. Deliberately skips the service-area
 * gate: that guard exists to stop out-of-area self-serve bookings, and the
 * operator is physically standing at the bin. Creates a real customer so the
 * receipt, wash GIF, and rating funnel all work and the customer can be
 * upsold a plan later.
 */
export async function handleNewJob(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const parsed = newJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  const data = parsed.data;
  // Default to today — the overwhelmingly common walk-up case (operator is
  // at the bin right now); an explicit date is the "come back in two weeks" deal.
  const scheduledForISO = data.scheduled_for ?? operatorTodayISO();

  try {
    const db = getDb();
    const visitId = crypto.randomUUID();
    // customer.email is NOT NULL + UNIQUE. A walk-up who won't share an email
    // still needs a valid row, so mint a routable-looking placeholder; the
    // send path skips these (see notifications).
    const email = data.email ?? `walkup+${visitId.slice(0, 8)}@luckyshamrock.ca`;

    // Read outside the transaction (mirrors api/book.ts).
    const [existing] = await db.select().from(customer).where(eq(customer.email, email));
    const customerId = existing?.id ?? crypto.randomUUID();
    const isNewCustomer = !existing;

    // Customer insert (if new) + visit insert in one transaction — a mid-flight
    // failure must not leave an orphan customer with zero visits behind.
    await db.transaction(async (tx) => {
      if (isNewCustomer) {
        await tx.insert(customer).values({
          id: customerId,
          email,
          name: data.name ?? 'Walk-up customer',
          street: data.street,
          city: data.city ?? 'Fort Saskatchewan',
          postalCode: normalizePostalCode(data.postal_code),
          pickupDay: 'wednesday', // unused for one-offs; column is NOT NULL
        });
      }

      await tx.insert(visit).values({
        id: visitId,
        customerId,
        subscriptionId: null,
        binCount: data.bin_count,
        scheduledFor: new Date(`${scheduledForISO}T12:00:00Z`),
        status: 'scheduled',
      });
    });

    res.status(201).json({ status: 'ok', visit_id: visitId, customer_id: customerId, scheduled_for: scheduledForISO });
  } catch (err) {
    console.error('[operator/job] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/visit/:id/notify  → on_our_way email + heading_there
// ─────────────────────────────────────────────────────────────────────
export async function handleNotify(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db
      .select({
        status: visit.status,
        headingThereAt: visit.headingThereAt,
        customerId: visit.customerId,
        email: customer.email,
        name: customer.name,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .where(eq(visit.id, visitId));

    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (!isActionableVisitStatus(row.status)) {
      res.status(409).json({ status: 'not_actionable', message: `visit is ${row.status}` });
      return;
    }

    // The operator IS heading there regardless of whether the email sends, so
    // mark it first. Keep the original heading_there_at on a re-tap.
    await db
      .update(visit)
      .set({ status: 'heading_there', headingThereAt: row.headingThereAt ?? new Date() })
      .where(eq(visit.id, visitId));

    // Idempotent on (visitId, 'on_our_way') — a double-tap sends no second email.
    // Skip the email for placeholder addresses (walk-up customers who gave no email).
    const tpl = onOurWayTemplate({ name: row.name });
    const result = isPlaceholderEmail(row.email)
      ? { skipped: true as const }
      : await sendAndLog({
        kind: 'on_our_way',
        to: row.email,
        subject: tpl.subject,
        body: tpl.text,
        html: tpl.html,
        customerId: row.customerId,
        visitId,
      });

    res.status(200).json({ status: 'ok', skipped: result.skipped ?? false });
  } catch (err) {
    console.error('[operator/visit/notify] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/visit/:id/done  → done email (next clean date) + done_at
// ─────────────────────────────────────────────────────────────────────
export async function handleDone(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
    return;
  }
  // Optional on-the-spot discount (cents) the operator entered in /ops.
  const discountCents = Number.isFinite(req.body?.discount_cents)
    ? Math.max(0, Math.trunc(req.body.discount_cents))
    : 0;
  const paymentParsed = donePaymentSchema.safeParse({
    payment_method: req.body?.payment_method,
    amount_cents: req.body?.amount_cents,
  });
  if (!paymentParsed.success) {
    res.status(400).json({ status: 'invalid', message: 'payment_method or amount_cents is invalid' });
    return;
  }
  const paymentMethod = paymentParsed.data.payment_method;
  const photoPairs = parsePhotoPairs(req.body);
  if (!photoPairs.ok) {
    res.status(400).json({ status: 'invalid', message: photoPairs.message });
    return;
  }
  const pairs = photoPairs.pairs;

  try {
    const db = getDb();
    const [row] = await db
      .select({
        status: visit.status,
        scheduledFor: visit.scheduledFor,
        paymentStatus: visit.paymentStatus,
        visitBinCount: visit.binCount,
        subId: visit.subscriptionId,
        customerId: visit.customerId,
        headingThereAt: visit.headingThereAt,
        email: customer.email,
        name: customer.name,
        street: customer.street,
        city: customer.city,
        postalCode: customer.postalCode,
        stripeCustomerId: customer.stripeCustomerId,
        defaultPaymentMethodId: customer.defaultPaymentMethodId,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .where(eq(visit.id, visitId));

    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (!isActionableVisitStatus(row.status)) {
      res.status(409).json({ status: 'not_actionable', message: `visit is ${row.status}` });
      return;
    }

    // Atomically CLAIM the visit: flip scheduled/heading_there → done in one
    // UPDATE guarded by the status. The read-check above can race a second
    // concurrent Done tap; this claim cannot — only one UPDATE matches, so the
    // loser gets 0 rows back and bails before charging (no double-charge, no
    // duplicate-payment 500).
    const claimed = await db
      .update(visit)
      .set({ status: 'done', doneAt: new Date() })
      .where(and(eq(visit.id, visitId), inArray(visit.status, ACTIONABLE_VISIT_STATUSES)))
      .returning({ id: visit.id });
    if (claimed.length === 0) {
      res.status(409).json({ status: 'not_actionable', message: 'visit is already done' });
      return;
    }

    // Next clean = the customer's next still-scheduled visit after this date.
    const [next] = await db
      .select({ scheduledFor: visit.scheduledFor })
      .from(visit)
      .where(
        and(
          eq(visit.customerId, row.customerId),
          eq(visit.status, 'scheduled'),
          gt(visit.scheduledFor, row.scheduledFor),
        ),
      )
      .orderBy(asc(visit.scheduledFor))
      .limit(1);
    const nextVisitDate = next ? next.scheduledFor.toISOString().slice(0, 10) : null;

    // ── Charge the card on file (best-effort) ───────────────────────────────
    // Only charge once per visit (skip if already charged/comped) and only when
    // the customer has a saved card. A charge failure flags the visit but NEVER
    // blocks marking the clean done. Resolve cadence for pricing: a visit with a
    // subscription bills at that cadence; a one-off (subId null) at the one-off
    // rate.
    let charge: { attempted: boolean; ok: boolean; amount_cents?: number; error?: string } = {
      attempted: false,
      ok: false,
    };
    let paymentUrl: string | null = null;
    let paymentQrSvg: string | null = null;
    const alreadyBilled = row.paymentStatus === 'charged' || row.paymentStatus === 'comped';
    // Cadence + bin count are needed by both billing and the PDF receipt.
    let cadence: Cadence | null = null;
    let binCount = row.visitBinCount ?? 1;
    if (row.subId) {
      const [sub] = await db.select().from(subscription).where(eq(subscription.id, row.subId));
      cadence = (sub?.cadence as Cadence) ?? null;
      binCount = sub?.binCount ?? binCount;
    }
    const baseCents = baseChargeCents(cadence, binCount);
    // The operator's amount override (if entered in /ops) replaces the
    // computed standard price for EVERY settlement method — the amount field
    // is editable no matter which payment button is selected, not just the
    // doorstep ones. Compute this once so all branches (and the receipt PDF
    // below, which must show a line item that agrees with the total) use the
    // same effective per-service amount.
    const effectiveBaseCents = paymentParsed.data.amount_cents ?? baseCents;
    // Doorstep settlement: the operator collected in person. No Stripe call —
    // the money is already in hand (cash) or captured in the Stripe app
    // (terminal, reconciled there by amount/time).
    // QR: Stripe hosts the payment page; we only hand the customer a link.
    // The visit completes now and the money confirms asynchronously via the
    // checkout.session.completed webhook.
    if (!alreadyBilled && paymentMethod === 'qr') {
      const amount = finalChargeCents(effectiveBaseCents, discountCents);
      const session = await createDoorstepCheckoutSession({
        visitId,
        amountCents: amount,
        description: `Garbage bin cleaning — ${binCount} bin${binCount > 1 ? 's' : ''}`,
      });
      if (session) {
        paymentUrl = session.url;
        // Rendered server-side so /ops needs no QR library (and no extra CDN
        // script). ~2 KB of SVG, injected straight into the page.
        try {
          paymentQrSvg = await QRCode.toString(session.url, { type: 'svg', margin: 1, width: 240 });
        } catch (err) {
          console.error('[operator/visit/done] qr render failed (link still returned)', err);
        }
        await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));
        await db.insert(payment).values({
          id: crypto.randomUUID(),
          customerId: row.customerId,
          visitId,
          amountCents: amount,
          discountCents,
          status: 'pending',
          method: 'qr',
        });
        charge = { attempted: true, ok: true, amount_cents: amount };
      }
    } else if (!alreadyBilled && (paymentMethod === 'cash' || paymentMethod === 'terminal')) {
      const amount = finalChargeCents(effectiveBaseCents, discountCents);
      const status = paymentMethod === 'cash' ? 'paid_cash' : 'paid_terminal';
      await db.update(visit).set({ paymentStatus: status }).where(eq(visit.id, visitId));
      await db.insert(payment).values({
        id: crypto.randomUUID(),
        customerId: row.customerId,
        visitId,
        amountCents: amount,
        discountCents,
        status: 'succeeded',
        method: paymentMethod,
      });
      charge = { attempted: true, ok: true, amount_cents: amount };
    } else if (!alreadyBilled && paymentMethod === 'card_on_file' && isStripeConfigured() && row.stripeCustomerId && row.defaultPaymentMethodId) {
      // B3: the /ops amount field is editable for card_on_file too — an
      // operator who types $30 and leaves the default payment method must
      // charge $30, not the standard price.
      const amount = finalChargeCents(effectiveBaseCents, discountCents);

      if (amount <= 0) {
        // Fully discounted → comp it, no Stripe call.
        await db.update(visit).set({ paymentStatus: 'comped' }).where(eq(visit.id, visitId));
        await db.insert(payment).values({
          id: crypto.randomUUID(),
          customerId: row.customerId,
          visitId,
          amountCents: 0,
          discountCents,
          status: 'succeeded',
        });
        charge = { attempted: true, ok: true, amount_cents: 0 };
      } else {
        charge.attempted = true;
        // Record the ledger row as `pending` BEFORE calling Stripe. If the
        // function dies between the charge and recording its result, a row still
        // exists for the webhook (payment_intent.succeeded/failed) to reconcile —
        // no successful charge with no local record.
        const paymentId = crypto.randomUUID();
        await db.insert(payment).values({
          id: paymentId,
          customerId: row.customerId,
          visitId,
          amountCents: amount,
          discountCents,
          status: 'pending',
        });
        const result = await chargeOffSession({
          stripeCustomerId: row.stripeCustomerId,
          paymentMethodId: row.defaultPaymentMethodId,
          amountCents: amount,
          description: `Lucky Shamrock clean — ${row.scheduledFor.toISOString().slice(0, 10)}`,
          idempotencyKey: `visit-${visitId}-charge`,
        });
        await db
          .update(payment)
          .set({
            stripePaymentIntentId: result.paymentIntentId ?? null,
            status: result.ok ? 'succeeded' : 'failed',
            failureReason: result.ok ? null : (result.error ?? 'charge_failed'),
            updatedAt: new Date(),
          })
          .where(eq(payment.id, paymentId));
        await db
          .update(visit)
          .set({ paymentStatus: result.ok ? 'charged' : 'failed' })
          .where(eq(visit.id, visitId));
        charge = { attempted: true, ok: result.ok, amount_cents: amount, error: result.ok ? undefined : result.error };
      }
    }

    // Idempotent on (visitId, 'done'). The email is the customer's receipt —
    // it carries the charge outcome and shows the next date in the same
    // friendly format as the booking confirmation.
    // QR is special: `charge.ok` here only means "a Checkout Session was
    // created," not "the customer paid." No money has moved yet — that's
    // confirmed later by the checkout.session.completed webhook (Task 5) — so
    // the email must not claim a charge. 'none' renders no payment sentence,
    // which is the truthful state at Done time. This does NOT touch the
    // `charge` object itself (still {attempted:true, ok:true, ...} for the
    // /ops UI and the HTTP response) — only the email's view of it.
    // cash/terminal each get their own truthful line (mirrors receipt-pdf.ts)
    // instead of falling through to 'charged', which used to falsely tell a
    // walk-up who paid cash that "your card on file was charged."
    const emailCharge: NonNullable<Parameters<typeof doneTemplate>[0]['charge']> = !charge.attempted
      ? { kind: 'none' }
      : paymentMethod === 'qr'
        ? { kind: 'none' }
        : paymentMethod === 'cash'
          ? { kind: 'cash' }
          : paymentMethod === 'terminal'
            ? { kind: 'terminal' }
            : !charge.ok
              ? { kind: 'failed' }
              : charge.amount_cents === 0
                ? { kind: 'comped' }
                : { kind: 'charged', amountCents: charge.amount_cents };
    // Per-visit wash animation: the whole story lives in ONE GIF (before
    // hold → Lucky frantically foams the photo → after reveal), with subtle
    // corner timestamps as proof of service. When it generates, the email
    // carries ONLY the GIF; the separate before/after photos are the
    // fallback. Strictly best-effort — any failure degrades to the photo
    // layout, never blocks Done (the charge has already happened above).
    // Multi-bin visits: the GIF is generated from bin 1 ONLY — sharp+gifenc
    // takes ~13s per pair, and this handler already runs close to the 30s
    // Vercel maxDuration with just one. Stacking N sequential GIFs would risk
    // timing out on a 3-bin visit, so bins 2+ always render as plain
    // before/after photo pairs (see extraBins below), never a GIF.
    // Ground-truth telemetry: exactly what photos reached the server on this
    // Done. Lets us tell "operator skipped the before photo" apart from "GIF
    // generation failed" without guessing from the customer's inbox.
    console.log(
      '[operator/visit/done] photos',
      JSON.stringify({
        visitId,
        bins: pairs.length,
        sizes: pairs.map((p) => ({
          before: p.before ? Math.round(p.before.contentBase64.length * 0.75) : 0,
          after: p.after ? Math.round(p.after.contentBase64.length * 0.75) : 0,
        })),
      }),
    );
    const photoAttachments: EmailAttachment[] = [];
    let hasWashGif = false;
    const heroPair = pairs[0];
    if (heroPair?.after && heroPair?.before) {
      const gifStart = Date.now();
      try {
        const stampTime = (d: Date) =>
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Edmonton',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }).format(d);
        const gif = await generateWashGif({
          beforeJpeg: Buffer.from(heroPair.before.contentBase64, 'base64'),
          afterJpeg: Buffer.from(heroPair.after.contentBase64, 'base64'),
          sprites: LEPRECHAUN_SPRITES,
          stamps: {
            // Before ≈ arrival ("on my way" tap); after = the Done tap.
            before: `BEFORE · ${stampTime(row.headingThereAt ?? new Date())}`,
            after: `AFTER · ${stampTime(new Date())}`,
          },
        });
        photoAttachments.push({
          filename: 'lucky-wash.gif',
          contentType: 'image/gif',
          contentBase64: gif.toString('base64'),
          inline: true,
          contentId: DONE_WASH_GIF_CID,
        });
        hasWashGif = true;
        console.log(`[operator/visit/done] wash gif ok in ${Date.now() - gifStart}ms (${Math.round(gif.length / 1024)}KB)`);
      } catch (err) {
        console.error(`[operator/visit/done] wash gif failed after ${Date.now() - gifStart}ms (email falls back to photos)`, err);
      }
    }
    if (!hasWashGif && heroPair?.after) {
      if (heroPair.before) {
        photoAttachments.push({ ...heroPair.before, inline: true, contentId: DONE_BEFORE_PHOTO_CID });
      }
      photoAttachments.push({ ...heroPair.after, inline: true, contentId: DONE_AFTER_PHOTO_CID });
    }
    // Bins 2+ never get a GIF — always plain before/after (or after-only),
    // same anti-testimonial rule as bin 1 (no "before" without an "after").
    const extraBins = pairs.slice(1).map((pair, i) => {
      const n = i + 2;
      if (pair.after) {
        if (pair.before) {
          photoAttachments.push({ ...pair.before, inline: true, contentId: binBeforePhotoCid(n) });
        }
        photoAttachments.push({ ...pair.after, inline: true, contentId: binAfterPhotoCid(n) });
      }
      return { hasBefore: !!pair.before, hasAfter: !!pair.after };
    });
    // PDF receipt whenever money changed hands (or was explicitly comped) on
    // THIS tap. Regular attachment (paperclip), not inline. Best-effort. QR is
    // excluded here: the customer hasn't actually paid yet at this point —
    // confirmation arrives later via the checkout.session.completed webhook.
    if (charge.attempted && charge.ok && paymentMethod !== 'qr') {
      try {
        const planLabel =
          cadence === null
            ? 'One-Time Clean'
            : cadence === 'monthly'
              ? 'Monthly Plan'
              : cadence === 'seasonal'
                ? 'Three Wash Season'
                : cadence === 'bimonthly'
                  ? 'Bimonthly Plan'
                  : 'Quarterly Plan';
        const pdf = await generateReceiptPdf({
          receiptNumber: `LS-${visitId.slice(0, 6).toUpperCase()}`,
          serviceDate: formatFriendlyDate(row.scheduledFor.toISOString().slice(0, 10)),
          paidDate: formatFriendlyDate(new Date().toISOString().slice(0, 10)),
          customerName: row.name,
          address: `${row.street}, ${row.city} ${row.postalCode}`,
          planLabel,
          binCount,
          // The effective (possibly operator-overridden) base, so the line
          // item minus the discount always agrees with TOTAL PAID below.
          baseCents: effectiveBaseCents,
          discountCents,
          totalCents: charge.amount_cents ?? 0,
          outcome:
            paymentMethod === 'cash'
              ? 'cash'
              : paymentMethod === 'terminal'
                ? 'terminal'
                : (charge.amount_cents ?? 0) === 0
                  ? 'comped'
                  : 'charged',
        });
        photoAttachments.push({
          filename: 'LuckyShamrock-Receipt.pdf',
          contentType: 'application/pdf',
          contentBase64: pdf.toString('base64'),
        });
      } catch (err) {
        console.error('[operator/visit/done] receipt pdf failed (email sends without it)', err);
      }
    }
    // Tap-a-star rating links (visit-scoped HMAC — no login needed).
    const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';
    let ratingBaseUrl: string | null = null;
    try {
      ratingBaseUrl = `${siteUrl}/api/rate?v=${encodeURIComponent(visitId)}&t=${encodeURIComponent(signRatingToken(visitId))}`;
    } catch {
      // SESSION_SECRET missing (local dev) → fall back to the plain review link.
    }
    const tpl = doneTemplate({
      name: row.name,
      nextVisitDate: nextVisitDate ? formatFriendlyDate(nextVisitDate) : null,
      reviewUrl: process.env.REVIEW_URL || null,
      hasPhoto: !!heroPair?.after,
      hasBeforePhoto: !!heroPair?.after && !!heroPair?.before,
      hasWashGif,
      extraBins,
      ratingBaseUrl,
      charge: emailCharge,
    });
    const result = isPlaceholderEmail(row.email)
      ? { skipped: true as const }
      : await sendAndLog({
      kind: 'done',
      to: row.email,
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      customerId: row.customerId,
      visitId,
      attachments: photoAttachments.length ? photoAttachments : undefined,
    });

    res.status(200).json({
      status: 'ok',
      next_visit_date: nextVisitDate,
      skipped: result.skipped ?? false,
      charge,
      // Explicit, unmistakable signal for /ops: nothing was collected on this
      // tap (no card on file / Stripe unconfigured, and the operator didn't
      // pick cash/terminal/qr). Done never blocks on this — it's a warning,
      // not an error — but it must not be silently inferable-only from
      // `charge.attempted` (easy to overlook client-side).
      nothing_collected: !charge.attempted,
      payment_url: paymentUrl,
      payment_qr_svg: paymentQrSvg,
    });
  } catch (err) {
    console.error('[operator/visit/done] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/visit/:id/skip  → mark skipped (no replacement)
// ─────────────────────────────────────────────────────────────────────
export async function handleSkip(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db.select({ status: visit.status }).from(visit).where(eq(visit.id, visitId));
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (!isActionableVisitStatus(row.status)) {
      res.status(409).json({ status: 'not_actionable', message: `visit is ${row.status}` });
      return;
    }

    // Operator skip ("bin wasn't out") just marks the visit skipped. Unlike a
    // customer skip, it does NOT insert a replacement — the recurring schedule
    // continues with the next already-scheduled visit.
    await db.update(visit).set({ status: 'skipped' }).where(eq(visit.id, visitId));

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[operator/visit/skip] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/visit/:id/note  → append a note line
// ─────────────────────────────────────────────────────────────────────
export async function handleNote(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
    return;
  }
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db.select({ notes: visit.notes }).from(visit).where(eq(visit.id, visitId));
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }

    // Append on a new line so the operator builds up a per-stop log.
    const newNotes = row.notes ? `${row.notes}\n${parsed.data.text}` : parsed.data.text;
    await db.update(visit).set({ notes: newNotes }).where(eq(visit.id, visitId));

    res.status(200).json({ status: 'ok', notes: newNotes });
  } catch (err) {
    console.error('[operator/visit/note] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/operator/attention  → done visits whose payment still needs action
//
// A declined card never blocks "Done", so failed charges would otherwise vanish
// — and so would a QR nobody's scanned yet, or a walk-up where nothing was
// collected at all (no card on file, operator forgot to tap Cash). This is the
// operator's "money owed" surface: done visits with payment_status in
// (failed, awaiting_payment, unpaid), newest first, with contact + amount + reason.
// ─────────────────────────────────────────────────────────────────────
export async function handleAttention(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: visit.id,
        scheduledFor: visit.scheduledFor,
        doneAt: visit.doneAt,
        paymentStatus: visit.paymentStatus,
        amountCents: payment.amountCents,
        failureReason: payment.failureReason,
        name: customer.name,
        phone: customer.phone,
        street: customer.street,
        city: customer.city,
        postalCode: customer.postalCode,
        hasCard: customer.defaultPaymentMethodId,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      // Widened from `status='failed'` only — an awaiting_payment visit's
      // real payment row is still `pending` (QR not yet confirmed by the
      // webhook), and that row is what carries the amount owed. Without
      // 'pending' here the join never matches for those rows and the UI
      // shows "Owed —" for every QR-in-flight visit (see N2).
      .leftJoin(payment, and(eq(payment.visitId, visit.id), inArray(payment.status, ['failed', 'pending'])))
      .where(
        and(
          eq(visit.status, 'done'),
          inArray(visit.paymentStatus, ['failed', 'awaiting_payment', 'unpaid']),
        ),
      )
      .orderBy(desc(visit.doneAt), desc(payment.createdAt));

    // A visit can carry >1 failed payment row after retries — keep the newest per visit.
    const seen = new Set<string>();
    const visits: unknown[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      visits.push({
        id: r.id,
        scheduled_for: r.scheduledFor,
        // /ops needs this to pick the right badge/label and to decide whether
        // Retry is even offered — without it every row rendered as "card
        // failed" regardless of the real state (see N2).
        payment_status: r.paymentStatus,
        amount_cents: r.amountCents ?? null,
        failure_reason: r.failureReason ?? null,
        has_card: Boolean(r.hasCard),
        customer: { name: r.name, phone: r.phone, street: r.street, city: r.city, postal_code: r.postalCode },
      });
    }
    res.status(200).json({ status: 'ok', visits });
  } catch (err) {
    console.error('[operator/attention] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/act {op:'retry'}  → re-charge a visit whose card declined
// ─────────────────────────────────────────────────────────────────────
export async function handleRetry(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db
      .select({
        paymentStatus: visit.paymentStatus,
        scheduledFor: visit.scheduledFor,
        visitBinCount: visit.binCount,
        subId: visit.subscriptionId,
        customerId: visit.customerId,
        stripeCustomerId: customer.stripeCustomerId,
        defaultPaymentMethodId: customer.defaultPaymentMethodId,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .where(eq(visit.id, visitId));

    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (row.paymentStatus !== 'failed') {
      res.status(409).json({ status: 'not_failed', message: `visit payment is ${row.paymentStatus}` });
      return;
    }
    if (!isStripeConfigured() || !row.stripeCustomerId || !row.defaultPaymentMethodId) {
      res.status(422).json({ status: 'no_card', message: 'No card on file to retry.' });
      return;
    }

    // Re-charge the amount of the last failed attempt (preserves the original
    // on-the-spot discount); fall back to recomputing the base if none exists.
    const [lastFailed] = await db
      .select()
      .from(payment)
      .where(and(eq(payment.visitId, visitId), eq(payment.status, 'failed')))
      .orderBy(desc(payment.createdAt))
      .limit(1);
    let amount = lastFailed?.amountCents ?? null;
    let discount = lastFailed?.discountCents ?? 0;
    if (amount === null) {
      let cadence: Cadence | null = null;
      let binCount = row.visitBinCount ?? 1;
      if (row.subId) {
        const [sub] = await db.select().from(subscription).where(eq(subscription.id, row.subId));
        cadence = (sub?.cadence as Cadence) ?? null;
        binCount = sub?.binCount ?? binCount;
      }
      amount = finalChargeCents(baseChargeCents(cadence, binCount), 0);
      discount = 0;
    }

    const paymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      customerId: row.customerId,
      visitId,
      amountCents: amount,
      discountCents: discount,
      status: 'pending',
    });
    const result = await chargeOffSession({
      stripeCustomerId: row.stripeCustomerId,
      paymentMethodId: row.defaultPaymentMethodId,
      amountCents: amount,
      description: `Lucky Shamrock clean (retry) — ${row.scheduledFor.toISOString().slice(0, 10)}`,
      // Fresh key per retry — a deterministic key would just replay the decline.
      idempotencyKey: `visit-${visitId}-retry-${paymentId}`,
    });
    await db
      .update(payment)
      .set({
        stripePaymentIntentId: result.paymentIntentId ?? null,
        status: result.ok ? 'succeeded' : 'failed',
        failureReason: result.ok ? null : (result.error ?? 'charge_failed'),
        updatedAt: new Date(),
      })
      .where(eq(payment.id, paymentId));
    await db
      .update(visit)
      .set({ paymentStatus: result.ok ? 'charged' : 'failed' })
      .where(eq(visit.id, visitId));

    res.status(200).json({
      status: 'ok',
      charge: { ok: result.ok, amount_cents: amount, error: result.ok ? undefined : result.error },
    });
  } catch (err) {
    console.error('[operator/retry] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/act  → single-segment entry for visit actions
//
// Vercel's runtime only matches our 1-segment operator route reliably; a
// 2+/-segment path (visit/:id/:action) 404'd at the platform before reaching
// the function. So visit actions come in through this one route with the visit
// id + op in the BODY ({id, op, text?}) instead of the URL. It validates, then
// delegates to the existing per-op handlers, which read the id off req.query.id.
// ─────────────────────────────────────────────────────────────────────
const ACT_HANDLERS: Record<string, (req: VercelRequest, res: VercelResponse) => Promise<void>> = {
  notify: handleNotify,
  done: handleDone,
  skip: handleSkip,
  note: handleNote,
  retry: handleRetry,
};

export async function handleAct(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  // Auth-check up front so a bad/no cookie returns 401 before body validation.
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const parsed = actSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  // Bridge to the per-op handlers, which expect the visit id on req.query.id.
  (req.query as Record<string, string | string[]>).id = parsed.data.id;
  return ACT_HANDLERS[parsed.data.op]!(req, res);
}
