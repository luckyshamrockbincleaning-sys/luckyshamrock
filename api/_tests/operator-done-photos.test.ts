import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.OPERATOR_SECRET = 'o'.repeat(48);
process.env.OPERATOR_PASSWORD = 'lucky-route-2026';

const delSpy = vi.fn(async () => undefined);
const listSpy = vi.fn(async () => ({ blobs: [{ url: 'https://blob.example/a.jpg', pathname: 'visits/v/0-before-a.jpg' }] }));
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async () => ({ url: 'https://blob.example/a.jpg' })),
  del: (...a: any[]) => delSpy(...(a as [])),
  list: (...a: any[]) => listSpy(...(a as [])),
}));

const { handleDone } = await import('../../lib/operator-handlers.js');
const { truncateAllForTests } = await import('./_db_cleanup.js');
const { getDb } = await import('../../db/client.js');
const { customer, visit } = await import('../../db/schema.js');
const { signOperatorCookie, OPERATOR_COOKIE_NAME } = await import('../../lib/operator.js');
const templates = await import('../../lib/email/templates.js');

// Must be a real-shaped Blob url inside THIS visit's folder — anything else is
// refused by the SSRF guard, which is the point of the guard.
const blobUrl = (visitId: string, kind: string) =>
  `https://store1.public.blob.vercel-storage.com/visits/${visitId}/0-${kind}-abc.jpg`;

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});

beforeEach(async () => {
  await truncateAllForTests();
  delSpy.mockClear();
  // A 1x1 JPEG is enough — nothing here inspects the pixels.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
  })));
});

function mockRes(): any {
  return {
    statusCode: 0,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    setHeader() { return this; },
  };
}

async function req(id: string, body: Record<string, unknown>): Promise<any> {
  return {
    method: 'POST',
    headers: { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` },
    query: { id },
    body,
  };
}

async function seed(): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `up-${customerId.slice(0, 8)}@e.com`,
    name: 'Pat',
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: null,
    scheduledFor: new Date('2026-06-10T12:00:00Z'),
    status: 'scheduled',
  });
  return visitId;
}

describe('Done with uploaded photos', () => {
  it('accepts urls and attaches what it fetched back', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: [{ before_url: blobUrl(visitId, 'before'), after_url: blobUrl(visitId, 'after') }],
    }), res);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deletes the visit photos once the email has gone', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: [{ before_url: blobUrl(visitId, 'before'), after_url: blobUrl(visitId, 'after') }],
    }), res);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // cleanup is fire-and-forget
    expect(delSpy).toHaveBeenCalled();
  });

  it('finishes the job even when a photo cannot be fetched back', async () => {
    const visitId = await seed();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('gone'); }));
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: [{ before_url: blobUrl(visitId, 'before'), after_url: blobUrl(visitId, 'after') }],
    }), res);
    // The clean happened. A photo we cannot retrieve costs an image, not the job.
    expect(res.statusCode).toBe(200);
  });

  it('still accepts inline photos from a no-signal fallback', async () => {
    const visitId = await seed();
    const spy = vi.spyOn(templates, 'doneTemplate');
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: [{ after: { filename: 'a.jpg', mime_type: 'image/jpeg', content_base64: 'AQID' } }],
    }), res);
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('accepts a six-bin job of urls', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: Array.from({ length: 6 }, () => ({
        before_url: blobUrl(visitId, 'before'),
        after_url: blobUrl(visitId, 'after'),
      })),
    }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('sweeping photos from jobs that never finished', () => {
  it('sweeps after answering, and never at the cost of the answer', async () => {
    const { handleToday } = await import('../../lib/operator-handlers.js');
    listSpy.mockClear();
    const res = mockRes();
    await handleToday({
      method: 'GET',
      headers: { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` },
      query: {},
    } as any, res);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(listSpy).toHaveBeenCalledWith({ prefix: 'visits/' });
  });

  it('still returns the route when the sweep blows up', async () => {
    const { handleToday } = await import('../../lib/operator-handlers.js');
    listSpy.mockRejectedValueOnce(new Error('blob down') as never);
    const res = mockRes();
    await handleToday({
      method: 'GET',
      headers: { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` },
      query: {},
    } as any, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('Done refuses a photo url that is not ours', () => {
  it('does not fetch an attacker-supplied host, and still finishes the job', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handleDone(await req(visitId, {
      payment_method: 'cash',
      photos: [{ after_url: 'http://169.254.169.254/latest/meta-data/' }],
    }), res);
    // The job completes — Done must never fail at a door — but nothing was
    // fetched and nothing reaches the customer's email.
    expect(res.statusCode).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});
