import { describe, it, expect } from 'vitest';
import { toOperatorVisit, type OperatorVisitRow } from '../operator.js';

function row(over: Partial<OperatorVisitRow> = {}): OperatorVisitRow {
  return {
    id: 'v1',
    customerId: 'c1',
    scheduledFor: new Date('2026-08-26T00:00:00Z'),
    status: 'scheduled',
    paymentStatus: 'unpaid',
    notes: null,
    headingThereAt: null,
    doneAt: null,
    name: 'Keltie Herzog',
    email: 'keltherzy@gmail.com',
    phone: '780-245-0216',
    street: '20 Alderson close',
    city: 'Fort Saskatchewan',
    postalCode: null,
    binLocation: null,
    binCount: 2,
    ...over,
  };
}

describe('the operator stop DTO carries the email', () => {
  // Without this the operator cannot see the address we send photos and
  // receipts to, so a wrong one is invisible until a customer complains —
  // which is exactly how keltie Herzog's emails reached Teri Lorenz for three
  // days in August.
  it('exposes the customer email', () => {
    expect(toOperatorVisit(row()).email).toBe('keltherzy@gmail.com');
  });

  it('reports a walk-up placeholder as having no email', () => {
    // Showing "walkup+3a310788@luckyshamrock.ca" on a route card reads like a
    // real address. The operator needs to know there is nowhere to send.
    const dto = toOperatorVisit(row({ email: 'walkup+3a310788@luckyshamrock.ca' }));
    expect(dto.email).toBeNull();
    expect(dto.has_email).toBe(false);
  });

  it('flags a real address as contactable', () => {
    expect(toOperatorVisit(row()).has_email).toBe(true);
  });

  it('treats a missing email as no email rather than throwing', () => {
    const dto = toOperatorVisit(row({ email: undefined as unknown as string }));
    expect(dto.email).toBeNull();
    expect(dto.has_email).toBe(false);
  });
});
