import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/client.js';
import { customer, visit, payment } from '../../db/schema.js';
import { truncateAllForTests } from '../../api/_tests/_db_cleanup.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => {
  await truncateAllForTests();
});

describe('payment method + doorstep payment states', () => {
  it('stores a cash payment with method=cash and visit paid_cash', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: `cash-${customerId.slice(0, 8)}@e.com`,
      name: 'Cash Customer',
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
      scheduledFor: new Date('2026-07-24T12:00:00Z'),
      status: 'done',
      paymentStatus: 'paid_cash',
    });
    const paymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      customerId,
      visitId,
      amountCents: 4500,
      status: 'succeeded',
      method: 'cash',
    });

    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    expect(v!.paymentStatus).toBe('paid_cash');
    expect(p!.method).toBe('cash');
  });

  it('defaults method to card for existing-style rows', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: `card-${customerId.slice(0, 8)}@e.com`,
      name: 'Card Customer',
      street: '1 Rd',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L1A1',
      pickupDay: 'wednesday',
    });
    const paymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      customerId,
      visitId: null,
      amountCents: 3500,
      status: 'pending',
    });
    const [p] = await getDb().select().from(payment).where(eq(payment.id, paymentId));
    expect(p!.method).toBe('card');
  });
});
