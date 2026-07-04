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
import { sendAndLog } from './notifications.js';
import { onOurWayTemplate, doneTemplate, DONE_BEFORE_PHOTO_CID, DONE_AFTER_PHOTO_CID } from './email/templates.js';
import { isStripeConfigured } from './stripe.js';
import { chargeOffSession } from './billing.js';
import { baseChargeCents, finalChargeCents } from './pricing.js';
import { formatFriendlyDate } from './dates.js';
import type { Cadence } from './schedule.js';
import type { EmailAttachment } from './email.js';

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

function parsePhotoAttachment(
  input: unknown,
  field: 'clean_photo' | 'before_photo',
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

  const fallbackFilename = field === 'before_photo' ? `before-bin.${ext}` : `clean-bin.${ext}`;
  return {
    ok: true,
    attachment: {
      filename: parsed.data.filename?.replace(/[^A-Za-z0-9._-]/g, '_') || fallbackFilename,
      contentType: parsed.data.mime_type,
      contentBase64: base64,
    },
  };
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
    const tpl = onOurWayTemplate({ name: row.name });
    const result = await sendAndLog({
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
  const cleanPhoto = parsePhotoAttachment(req.body?.clean_photo, 'clean_photo');
  if (!cleanPhoto.ok) {
    res.status(400).json({ status: 'invalid', message: cleanPhoto.message });
    return;
  }
  const beforePhoto = parsePhotoAttachment(req.body?.before_photo, 'before_photo');
  if (!beforePhoto.ok) {
    res.status(400).json({ status: 'invalid', message: beforePhoto.message });
    return;
  }

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
        email: customer.email,
        name: customer.name,
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
    const alreadyBilled = row.paymentStatus === 'charged' || row.paymentStatus === 'comped';
    if (!alreadyBilled && isStripeConfigured() && row.stripeCustomerId && row.defaultPaymentMethodId) {
      let cadence: Cadence | null = null;
      let binCount = row.visitBinCount ?? 1;
      if (row.subId) {
        const [sub] = await db.select().from(subscription).where(eq(subscription.id, row.subId));
        cadence = (sub?.cadence as Cadence) ?? null;
        binCount = sub?.binCount ?? binCount;
      }
      const base = baseChargeCents(cadence, binCount);
      const amount = finalChargeCents(base, discountCents);

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
    const emailCharge: NonNullable<Parameters<typeof doneTemplate>[0]['charge']> = !charge.attempted
      ? { kind: 'none' }
      : !charge.ok
        ? { kind: 'failed' }
        : charge.amount_cents === 0
          ? { kind: 'comped' }
          : { kind: 'charged', amountCents: charge.amount_cents };
    // Photos render inline in the email body (cid: refs in the template).
    // The before shot rides along only when the after shot exists — a
    // "before" with nothing to compare against would be an anti-testimonial.
    const photoAttachments: EmailAttachment[] = [];
    if (cleanPhoto.attachment) {
      if (beforePhoto.attachment) {
        photoAttachments.push({ ...beforePhoto.attachment, inline: true, contentId: DONE_BEFORE_PHOTO_CID });
      }
      photoAttachments.push({ ...cleanPhoto.attachment, inline: true, contentId: DONE_AFTER_PHOTO_CID });
    }
    const tpl = doneTemplate({
      name: row.name,
      nextVisitDate: nextVisitDate ? formatFriendlyDate(nextVisitDate) : null,
      reviewUrl: process.env.REVIEW_URL || null,
      hasPhoto: !!cleanPhoto.attachment,
      hasBeforePhoto: !!cleanPhoto.attachment && !!beforePhoto.attachment,
      charge: emailCharge,
    });
    const result = await sendAndLog({
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
// GET /api/operator/attention  → visits whose charge FAILED (need a retry)
//
// A declined card never blocks "Done", so failed charges would otherwise vanish.
// This is the operator's "money owed" surface: done visits still flagged
// payment_status='failed', newest first, with contact + the amount + reason.
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
      .leftJoin(payment, and(eq(payment.visitId, visit.id), eq(payment.status, 'failed')))
      .where(eq(visit.paymentStatus, 'failed'))
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
