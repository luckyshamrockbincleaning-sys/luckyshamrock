import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * booking-resume.js is a plain <script> (no build step, same as pricing.js), so
 * it cannot be imported. Run it in a vm with a fake window + sessionStorage and
 * test the real behaviour rather than parsing the source.
 *
 * What it guards: a full-page navigation between "card saved" and "booking
 * submitted" used to lose every field the customer had typed. Stripe performs
 * exactly that navigation when an issuer demands a full-page 3-D Secure
 * challenge, and Android reloads backgrounded tabs for its own reasons.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'booking-resume.js'), 'utf8');

function freshResume() {
  const store = new Map<string, string>();
  const sandbox: any = {
    window: {
      sessionStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    },
  };
  sandbox.window.window = sandbox.window;
  createContext(sandbox);
  runInContext(src, sandbox);
  return { R: sandbox.window.LS_BOOKING_RESUME, store };
}

const STATE = {
  service: 'monthly',
  contact: { name: 'Mia Kang', email: 'mia@example.com', street: '125 Richmond Link' },
  binTypes: ['garbage', 'organics'],
  paymentSetup: { stripe_customer_id: 'cus_123', setup_intent_id: 'seti_123' },
};

describe('booking resume store', () => {
  let R: any;
  beforeEach(() => { R = freshResume().R; });

  it('gives back exactly what was saved', () => {
    R.save(STATE);
    expect(R.load()).toEqual(STATE);
  });

  it('keeps the payment setup ids — without them the booking cannot be finished', () => {
    R.save(STATE);
    expect(R.load().paymentSetup.setup_intent_id).toBe('seti_123');
  });

  it('returns null when nothing was saved', () => {
    expect(R.load()).toBeNull();
  });

  it('forgets a booking older than the TTL', () => {
    const { R: R2, store } = freshResume();
    R2.save(STATE);
    const raw = JSON.parse(store.get('ls-booking-resume')!);
    raw.ts = Date.now() - (R2.TTL_MS + 1000);
    store.set('ls-booking-resume', JSON.stringify(raw));
    expect(R2.load()).toBeNull();
  });

  it('survives corrupt storage instead of throwing', () => {
    const { R: R2, store } = freshResume();
    store.set('ls-booking-resume', '{not json');
    expect(R2.load()).toBeNull();
  });

  it('clears', () => {
    R.save(STATE);
    R.clear();
    expect(R.load()).toBeNull();
  });
});

describe('detecting a return from the bank', () => {
  let R: any;
  beforeEach(() => { R = freshResume().R; });

  it('recognises a successful 3-D Secure return', () => {
    expect(R.pendingFromUrl('?setup_intent=seti_123&redirect_status=succeeded')).toEqual({
      setupIntentId: 'seti_123',
      status: 'succeeded',
    });
  });

  it('recognises a failed one, so the customer is not told they booked', () => {
    expect(R.pendingFromUrl('?setup_intent=seti_9&redirect_status=failed')).toEqual({
      setupIntentId: 'seti_9',
      status: 'failed',
    });
  });

  it('ignores an ordinary visit', () => {
    expect(R.pendingFromUrl('')).toBeNull();
    expect(R.pendingFromUrl('?utm_source=google')).toBeNull();
  });
});
