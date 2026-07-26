import { getStripe, isStripeConfigured } from './stripe.js';

/**
 * Domain-level billing helpers wrapping the Stripe SDK. Every function degrades
 * gracefully when Stripe is not configured (returns null / no-op) so that the
 * booking and operator flows never break in environments without keys — same
 * philosophy as lib/gmail.ts's stub path. The callers treat a null as "billing
 * not set up yet" and carry on.
 */

export interface EnsureStripeCustomerInput {
  email: string;
  name: string;
  phone?: string | null;
}

/**
 * Create a Stripe Customer and return its id, or null if Stripe isn't
 * configured. Caller persists the id on our customer row.
 */
export async function createStripeCustomer(input: EnsureStripeCustomerInput): Promise<string | null> {
  if (!isStripeConfigured()) return null;
  const stripe = getStripe();
  const c = await stripe.customers.create({
    email: input.email,
    name: input.name,
    phone: input.phone ?? undefined,
  });
  return c.id;
}

export interface SetupIntentResult {
  clientSecret: string;
  publishableKey: string;
}

export interface BookingSetupIntentInput {
  email: string;
  name: string;
  phone?: string | null;
}

export interface BookingSetupIntentResult extends SetupIntentResult {
  stripeCustomerId: string;
  setupIntentId: string;
}

/**
 * Create a SetupIntent so the customer can save a card on file (no charge).
 * Returns the client secret + publishable key for Stripe Elements on the
 * frontend, or null if Stripe isn't configured.
 */
export async function createSetupIntent(stripeCustomerId: string): Promise<SetupIntentResult | null> {
  if (!isStripeConfigured()) return null;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) return null;
  const stripe = getStripe();
  const si = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    usage: 'off_session', // we charge later, when the operator marks the visit done
  });
  if (!si.client_secret) return null;
  return { clientSecret: si.client_secret, publishableKey };
}

export async function createBookingSetupIntent(
  input: BookingSetupIntentInput,
): Promise<BookingSetupIntentResult | null> {
  if (!isStripeConfigured()) return null;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) return null;
  const stripe = getStripe();
  const c = await stripe.customers.create({
    email: input.email,
    name: input.name,
    phone: input.phone ?? undefined,
  });
  const si = await stripe.setupIntents.create({
    customer: c.id,
    payment_method_types: ['card'],
    usage: 'off_session',
  });
  if (!si.id || !si.client_secret) return null;
  return {
    stripeCustomerId: c.id,
    setupIntentId: si.id,
    clientSecret: si.client_secret,
    publishableKey,
  };
}

export async function getSavedPaymentMethodFromSetupIntent(
  setupIntentId: string,
  stripeCustomerId: string,
): Promise<string | null> {
  if (!isStripeConfigured()) return null;
  const stripe = getStripe();
  const si = await stripe.setupIntents.retrieve(setupIntentId);
  const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
  const paymentMethodId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (si.status !== 'succeeded') return null;
  if (customerId !== stripeCustomerId) return null;
  return paymentMethodId ?? null;
}

export interface ChargeResult {
  ok: boolean;
  paymentIntentId?: string;
  status?: string;
  error?: string;
}

export interface ChargeInput {
  stripeCustomerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency?: string;
  description?: string;
  /** Idempotency key so a double "Done" tap can't double-charge. */
  idempotencyKey?: string;
}

/**
 * Charge a saved card off-session (customer not present). Returns ok=false with
 * an error message on decline rather than throwing, so the operator "Done" flow
 * can record the failure and still complete the clean.
 */
export async function chargeOffSession(input: ChargeInput): Promise<ChargeResult> {
  if (!isStripeConfigured()) {
    return { ok: false, error: 'stripe_not_configured' };
  }
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency ?? 'cad',
        customer: input.stripeCustomerId,
        payment_method: input.paymentMethodId,
        off_session: true,
        confirm: true,
        description: input.description,
      },
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
    );
    return { ok: pi.status === 'succeeded', paymentIntentId: pi.id, status: pi.status };
  } catch (err) {
    // Card declines surface as StripeCardError with a payment_intent attached.
    const e = err as { message?: string; payment_intent?: { id?: string; status?: string } };
    return {
      ok: false,
      error: e.message ?? 'charge_failed',
      paymentIntentId: e.payment_intent?.id,
      status: e.payment_intent?.status,
    };
  }
}

export interface DoorstepCheckoutInput {
  visitId: string;
  amountCents: number;
  description: string;
}

export interface DoorstepCheckoutResult {
  url: string;
  sessionId: string;
}

/**
 * Stripe-hosted checkout for a doorstep QR payment. The customer scans the QR
 * on the operator's phone and pays on Stripe's page (Apple Pay / Google Pay /
 * card), so we host no payment UI and add no serverless function. Confirmation
 * arrives as `checkout.session.completed` on the existing webhook.
 *
 * Returns null (never throws) when Stripe is unconfigured or the call fails —
 * the caller falls back to another payment method and Done still completes.
 */
export async function createDoorstepCheckoutSession(
  input: DoorstepCheckoutInput,
): Promise<DoorstepCheckoutResult | null> {
  if (!isStripeConfigured()) return null;
  const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'cad',
            unit_amount: input.amountCents,
            product_data: { name: input.description },
          },
        },
      ],
      metadata: { visit_id: input.visitId },
      payment_intent_data: { metadata: { visit_id: input.visitId } },
      success_url: `${siteUrl}/paid.html`,
      cancel_url: `${siteUrl}/`,
    });
    if (!session.url) return null;
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    console.error('[billing] doorstep checkout session failed', err);
    return null;
  }
}
