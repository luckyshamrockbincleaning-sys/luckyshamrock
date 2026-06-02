/**
 * Operator endpoint handlers, consolidated into one module.
 *
 * Vercel Hobby allows at most 12 serverless functions per deployment. To keep
 * all operator routes in a single function, the real handler logic lives here
 * as named exports and the catch-all route `api/operator/[...path].ts`
 * dispatches to them. Each is a plain (req, res) handler — testable directly,
 * no routing layer in the way.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { and, eq, ne, gt, gte, lte, asc, sql } from 'drizzle-orm';
import { addDays } from 'date-fns';
import { getDb } from '../db/client.js';
import { customer, subscription, visit } from '../db/schema.js';
import {
  getOperatorSession,
  signOperatorCookie,
  formatOperatorCookieHeader,
  verifyOperatorPassword,
  operatorTodayISO,
  toOperatorVisit,
} from './operator.js';
import { sendAndLog } from './notifications.js';
import { onOurWayTemplate, doneTemplate } from './email/templates.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const loginSchema = z.object({ password: z.string().min(1) });
const noteSchema = z.object({ text: z.string().trim().min(1).max(1000) });
const actSchema = z
  .object({ id: z.string().min(1), op: z.enum(['notify', 'done', 'skip', 'note']) })
  .passthrough(); // keep `text` through for the note op

// Columns selected for the operator stop view (customer + subscription join).
const stopColumns = {
  id: visit.id,
  scheduledFor: visit.scheduledFor,
  status: visit.status,
  notes: visit.notes,
  headingThereAt: visit.headingThereAt,
  doneAt: visit.doneAt,
  name: customer.name,
  phone: customer.phone,
  street: customer.street,
  city: customer.city,
  postalCode: customer.postalCode,
  // One-offs store bin_count on the visit; recurring derive it from the
  // subscription. COALESCE picks whichever is present.
  binCount: sql<number | null>`coalesce(${visit.binCount}, ${subscription.binCount})`,
} as const;

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
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
      .where(and(eq(visit.scheduledFor, targetDate), ne(visit.status, 'cancelled')))
      .orderBy(asc(customer.name));

    res.status(200).json({ status: 'ok', date: targetISO, visits: rows.map(toOperatorVisit) });
  } catch (err) {
    console.error('[operator/today] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/operator/upcoming?days=7 (&date=YYYY-MM-DD anchor)
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

    let days = parseInt(String(req.query.days ?? ''), 10);
    if (!Number.isFinite(days)) days = 7;
    days = Math.max(1, Math.min(60, days));

    // Tomorrow through anchor+days, inclusive. Today is covered by /today.
    const start = addDays(anchor, 1);
    const end = addDays(anchor, days);

    const db = getDb();
    const rows = await db
      .select(stopColumns)
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .leftJoin(subscription, eq(visit.subscriptionId, subscription.id))
      .where(
        and(
          gte(visit.scheduledFor, start),
          lte(visit.scheduledFor, end),
          ne(visit.status, 'cancelled'),
        ),
      )
      .orderBy(asc(visit.scheduledFor), asc(customer.name));

    res.status(200).json({ status: 'ok', days, visits: rows.map(toOperatorVisit) });
  } catch (err) {
    console.error('[operator/upcoming] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
    if (row.status === 'done' || row.status === 'cancelled') {
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
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
  try {
    const db = getDb();
    const [row] = await db
      .select({
        status: visit.status,
        scheduledFor: visit.scheduledFor,
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
    if (row.status === 'cancelled') {
      res.status(409).json({ status: 'not_actionable', message: 'visit is cancelled' });
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

    await db.update(visit).set({ status: 'done', doneAt: new Date() }).where(eq(visit.id, visitId));

    // Idempotent on (visitId, 'done').
    const tpl = doneTemplate({ name: row.name, nextVisitDate, reviewUrl: process.env.REVIEW_URL || null });
    const result = await sendAndLog({
      kind: 'done',
      to: row.email,
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      customerId: row.customerId,
      visitId,
    });

    res.status(200).json({ status: 'ok', next_visit_date: nextVisitDate, skipped: result.skipped ?? false });
  } catch (err) {
    console.error('[operator/visit/done] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
    if (row.status === 'done' || row.status === 'cancelled') {
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
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
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
