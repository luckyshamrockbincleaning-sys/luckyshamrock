import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, visit } from '../db/schema.js';
import { verifyRatingToken } from '../lib/rating-token.js';
import { sendAndLog } from '../lib/notifications.js';
import { operatorFeedbackTemplate } from '../lib/email/templates.js';

/**
 * Tap-a-star rating from the done email.
 *
 *   GET  /api/rate?v=<visitId>&t=<token>&stars=1..5
 *     Records the rating, then 302s: 4-5 stars → the Google review page
 *     (REVIEW_URL), 1-3 stars → the private feedback form. Re-taps simply
 *     overwrite (customers change their minds).
 *
 *   POST /api/rate {v, t, comment}
 *     Saves the private comment from the feedback form and emails the
 *     operator (idempotent per visit via the notification log).
 *
 * Auth is the visit-scoped HMAC token — no session, no magic link, one tap.
 */

const postSchema = z.object({
  v: z.string().uuid(),
  t: z.string().min(10),
  comment: z.string().trim().min(1).max(2000),
});

const SITE = () => process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') return handleStars(req, res);
  if (req.method === 'POST') return handleComment(req, res);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function handleStars(req: VercelRequest, res: VercelResponse): Promise<void> {
  const v = typeof req.query.v === 'string' ? req.query.v : '';
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  const stars = Number(req.query.stars);
  if (!verifyRatingToken(v, t) || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    res.status(400).json({ status: 'invalid', message: 'This rating link is not valid.' });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db
      .update(visit)
      .set({ rating: stars, ratedAt: new Date() })
      .where(eq(visit.id, v))
      .returning({ id: visit.id });
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (stars >= 4) {
      // Happy customer → carry the momentum straight into the public review.
      res.status(302).setHeader('Location', process.env.REVIEW_URL || SITE()).end();
    } else {
      // Unhappy → private feedback form, not the Google review box.
      res
        .status(302)
        .setHeader('Location', `${SITE()}/feedback.html?v=${encodeURIComponent(v)}&t=${encodeURIComponent(t)}&stars=${stars}`)
        .end();
    }
  } catch (err) {
    console.error('[rate] stars failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}

async function handleComment(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success || !verifyRatingToken(parsed.data.v, parsed.data.t)) {
    res.status(400).json({ status: 'invalid', message: 'This feedback link is not valid.' });
    return;
  }
  try {
    const db = getDb();
    const [row] = await db
      .update(visit)
      .set({ ratingComment: parsed.data.comment, ratedAt: new Date() })
      .where(eq(visit.id, parsed.data.v))
      .returning({ id: visit.id, customerId: visit.customerId, rating: visit.rating, scheduledFor: visit.scheduledFor });
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    // Tell the operator — this is exactly the complaint that would otherwise
    // have been a public 1-star review. Best-effort; the comment is saved
    // regardless. Idempotent per (visit, kind): first comment wins the email.
    const operatorEmail = process.env.OPERATOR_NOTIFY_EMAIL || process.env.GMAIL_SEND_AS;
    if (operatorEmail) {
      try {
        const [c] = await db.select().from(customer).where(eq(customer.id, row.customerId));
        if (c) {
          const tpl = operatorFeedbackTemplate({
            name: c.name,
            email: c.email,
            phone: c.phone ?? null,
            rating: row.rating,
            comment: parsed.data.comment,
            visitDate: row.scheduledFor.toISOString().slice(0, 10),
          });
          await sendAndLog({
            kind: 'operator_feedback',
            to: operatorEmail,
            subject: tpl.subject,
            body: tpl.text,
            html: tpl.html,
            customerId: row.customerId,
            visitId: row.id,
          });
        }
      } catch (err) {
        console.error('[rate] operator feedback email failed (comment saved)', err);
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[rate] comment failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
