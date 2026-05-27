import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendEmail = vi.fn();
vi.mock('../email.js', () => ({ sendEmail: mockSendEmail }));

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockSelectWhere = vi.fn();
vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
    insert: () => ({ values: mockInsertValues }),
  }),
}));

const { sendAndLog } = await import('../notifications.js');

describe('sendAndLog', () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
    mockInsertValues.mockClear();
    mockSelectWhere.mockReset();
  });

  it('writes a notification_log row with sent_at + gmail_message_id on success', async () => {
    mockSendEmail.mockResolvedValueOnce({ ok: true, gmailMessageId: 'stub-abc' });
    mockSelectWhere.mockResolvedValueOnce([]); // no prior send

    const r = await sendAndLog({
      kind: 'booking_confirmed',
      to: 'sam@example.com',
      subject: 's',
      body: 'b',
      customerId: 'cust-1',
      visitId: 'visit-1',
    });

    expect(r.ok).toBe(true);
    expect(mockInsertValues).toHaveBeenCalledOnce();
    const row = mockInsertValues.mock.calls[0]![0];
    expect(row).toMatchObject({
      customerId: 'cust-1',
      visitId: 'visit-1',
      kind: 'booking_confirmed',
      gmailMessageId: 'stub-abc',
    });
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.failedAt).toBeUndefined();
  });

  it('writes a notification_log row with failed_at + error on failure', async () => {
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: 'gmail down' });
    mockSelectWhere.mockResolvedValueOnce([]);

    const r = await sendAndLog({
      kind: 'magic_link',
      to: 'sam@example.com',
      subject: 's',
      body: 'b',
      customerId: 'cust-1',
      visitId: null,
    });

    expect(r.ok).toBe(false);
    expect(mockInsertValues).toHaveBeenCalledOnce();
    const row = mockInsertValues.mock.calls[0]![0];
    expect(row).toMatchObject({
      customerId: 'cust-1',
      visitId: null,
      kind: 'magic_link',
      error: 'gmail down',
    });
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.sentAt).toBeUndefined();
  });

  it('skips re-sending if an identical (visit_id, kind) row already exists', async () => {
    mockSelectWhere.mockResolvedValueOnce([{ id: 'existing-log', sentAt: new Date() }]);

    const r = await sendAndLog({
      kind: 'on_our_way',
      to: 'sam@example.com',
      subject: 's',
      body: 'b',
      customerId: 'cust-1',
      visitId: 'visit-1',
    });

    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('does NOT skip when visit_id is null even if a prior magic_link exists', async () => {
    mockSendEmail.mockResolvedValueOnce({ ok: true, gmailMessageId: 'stub-2' });
    // visit_id=null: idempotency check should not run, no SELECT call required
    const r = await sendAndLog({
      kind: 'magic_link',
      to: 'sam@example.com',
      subject: 's',
      body: 'b',
      customerId: 'cust-1',
      visitId: null,
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
