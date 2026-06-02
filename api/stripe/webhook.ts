import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStripe, isStripeConfigured } from '../../lib/stripe.js';
import { applyStripeEvent } from '../../lib/billing-webhook.js';

/**
 * Stripe webhook receiver — the ONE new serverless function this phase adds
 * (keeps us at the Vercel Hobby 12-function cap). It must read the RAW request
 * body to verify the signature, so Vercel's automatic body parsing is disabled
 * below and we collect the stream ourselves.
 *
 * This endpoint is the source of truth for payment state: it updates payment +
 * visit rows when SetupIntents/PaymentIntents resolve. Always returns 2xx for
 * events we received-and-handled (even if ignored) so Stripe stops retrying;
 * returns 4xx only when the signature can't be verified.
 */
export const config = { api: { bodyParser: false } };

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!isStripeConfigured() || !secret) {
    // No keys configured — accept-and-ignore so a misconfigured webhook in a
    // preview env doesn't pile up Stripe retries.
    res.status(200).json({ status: 'ignored', reason: 'stripe_not_configured' });
    return;
  }

  const sig = req.headers['stripe-signature'];
  if (typeof sig !== 'string') {
    res.status(400).json({ status: 'invalid', message: 'missing stripe-signature' });
    return;
  }

  let event;
  try {
    const raw = await readRawBody(req);
    event = await getStripe().webhooks.constructEventAsync(raw, sig, secret);
  } catch (err) {
    // Signature verification failed — do NOT process. 400 tells Stripe it's bad.
    const message = err instanceof Error ? err.message : 'invalid_signature';
    console.error('[stripe/webhook] signature verification failed', message);
    res.status(400).json({ status: 'invalid', message });
    return;
  }

  try {
    const result = await applyStripeEvent(event);
    res.status(200).json({ status: 'ok', handled: result });
  } catch (err) {
    // We verified the event but failed to apply it. 500 makes Stripe retry.
    console.error('[stripe/webhook] apply failed', event.type, err);
    res.status(500).json({ status: 'error' });
  }
}
