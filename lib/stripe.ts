import Stripe from 'stripe';

/**
 * Lazy Stripe client singleton. Mirrors db/client.ts: the client is built on
 * first use, not at import time, so the module can be imported in environments
 * without STRIPE_SECRET_KEY (tests, unconfigured previews) without throwing.
 *
 * Callers that perform real charges should gate on isStripeConfigured() and
 * degrade gracefully when it's false — same philosophy as lib/gmail.ts's stub
 * path. Payments are additive: a missing key must never break booking or the
 * operator "Done" flow (the clean still completes; the charge is just skipped).
 */

let _stripe: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      // Pin the API version so behavior is stable across SDK bumps.
      apiVersion: '2026-05-27.dahlia',
      appInfo: { name: 'lucky-shamrock', url: 'https://www.luckyshamrock.ca' },
    });
  }
  return _stripe;
}
