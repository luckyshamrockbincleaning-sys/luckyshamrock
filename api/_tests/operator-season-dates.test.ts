import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleSeasonDates as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, season } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME, operatorTodayISO } from '../../lib/operator.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});
beforeEach(async () => { await truncateAllForTests(); });

function mockRes(): any {
  return { statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; }, setHeader() { return this; } };
}
async function req(method: string, body: unknown = {}, authed = true): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query: {}, body };
}

const YEAR = Number(operatorTodayISO().slice(0, 4));

async function seedVisit(name: string, day: string, status: 'scheduled' | 'done' = 'scheduled'): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId, email: `${crypto.randomUUID()}@example.com`, name, street: '1 Rd',
    city: 'Fort Saskatchewan', postalCode: 'T8L1A1', pickupDay: 'wednesday',
  });
  const id = crypto.randomUUID();
  await db.insert(visit).values({ id, customerId, scheduledFor: new Date(`${day}T12:00:00Z`), status, binCount: 1 });
  return id;
}

describe('/api/operator/season-dates', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req('GET', {}, false), res);
    expect(res.statusCode).toBe(401);
  });

  it('GET shows this year and next, defaulting to May 1 – Oct 31', async () => {
    const res = mockRes();
    await handler(await req('GET'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.seasons).toEqual([
      { year: YEAR, start: `${YEAR}-05-01`, end: `${YEAR}-10-31`, custom: false },
      { year: YEAR + 1, start: `${YEAR + 1}-05-01`, end: `${YEAR + 1}-10-31`, custom: false },
    ]);
  });

  it('POST saves a year, and saving again replaces it', async () => {
    let res = mockRes();
    await handler(await req('POST', { start: `${YEAR + 1}-05-01`, end: `${YEAR + 1}-10-16` }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.seasons[1]).toEqual({ year: YEAR + 1, start: `${YEAR + 1}-05-01`, end: `${YEAR + 1}-10-16`, custom: true });

    res = mockRes();
    await handler(await req('POST', { start: `${YEAR + 1}-05-15`, end: `${YEAR + 1}-10-20` }), res);
    const rows = await getDb().select().from(season);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ year: YEAR + 1, startsOn: `${YEAR + 1}-05-15`, endsOn: `${YEAR + 1}-10-20` });
  });

  it('rejects dates in different years, out of order, or not real', async () => {
    for (const body of [
      { start: `${YEAR + 1}-05-01`, end: `${YEAR + 2}-01-16` },
      { start: `${YEAR + 1}-10-16`, end: `${YEAR + 1}-05-01` },
      { start: `${YEAR + 1}-02-30`, end: `${YEAR + 1}-10-16` },
      { start: 'May 1', end: `${YEAR + 1}-10-16` },
      {},
    ]) {
      const res = mockRes();
      await handler(await req('POST', body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(await getDb().select().from(season)).toHaveLength(0);
  });

  it('lists open cleans the new dates leave outside the season, and never touches them', async () => {
    const y = YEAR + 1;
    const late = await seedVisit('Late Lucy', `${y}-10-20`);
    await seedVisit('Early Ed', `${y}-10-10`);
    await seedVisit('Finished Fay', `${y}-10-25`, 'done');

    const res = mockRes();
    await handler(await req('POST', { start: `${y}-05-01`, end: `${y}-10-16` }), res);
    expect(res.body.outside).toEqual([{ id: late, name: 'Late Lucy', scheduled_for: `${y}-10-20` }]);

    const visits = await getDb().select().from(visit);
    expect(visits).toHaveLength(3);
    expect(visits.find((v) => v.id === late)!.status).toBe('scheduled');
  });

  it('rejects other methods', async () => {
    const res = mockRes();
    await handler(await req('DELETE'), res);
    expect(res.statusCode).toBe(405);
  });
});
