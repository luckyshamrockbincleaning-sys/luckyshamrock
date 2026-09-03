import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set before the modules below are imported — signOperatorCookie reads it at
// call time, but the handler module resolves config on import.
process.env.OPERATOR_SECRET = 'o'.repeat(48);
process.env.OPERATOR_PASSWORD = 'lucky-upload-2026';

const putSpy = vi.fn();
vi.mock('@vercel/blob', () => ({
  put: (...a: any[]) => putSpy(...a),
  del: vi.fn(),
  list: vi.fn(async () => ({ blobs: [] })),
}));

const { handlePhotoUpload } = await import('../../lib/operator-handlers.js');
const { signOperatorCookie, OPERATOR_COOKIE_NAME } = await import('../../lib/operator.js');

function mockRes(): any {
  return {
    statusCode: 0,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
}

async function req(authed: boolean, body: any, method = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, body, query: {}, url: '/api/operator/upload' };
}

const goodBody = {
  visit_id: '11111111-1111-4111-8111-111111111111',
  bin_index: 0,
  kind: 'before',
  mime_type: 'image/jpeg',
  content_base64: Buffer.from('hello').toString('base64'),
};

beforeEach(() => {
  putSpy.mockReset();
  putSpy.mockResolvedValue({ url: 'https://blob.example/visits/x/0-before-y.jpg' });
});

describe('POST /api/operator/upload', () => {
  it('refuses an unauthenticated upload', async () => {
    const res = mockRes();
    await handlePhotoUpload(await req(false, goodBody), res);
    expect(res.statusCode).toBe(401);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('refuses a non-image mime type', async () => {
    const res = mockRes();
    await handlePhotoUpload(await req(true, { ...goodBody, mime_type: 'application/pdf' }), res);
    expect(res.statusCode).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('refuses a photo over the size cap', async () => {
    const res = mockRes();
    const huge = 'A'.repeat(8 * 1024 * 1024);
    await handlePhotoUpload(await req(true, { ...goodBody, content_base64: huge }), res);
    expect(res.statusCode).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns a url for a good photo', async () => {
    const res = mockRes();
    await handlePhotoUpload(await req(true, goodBody), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\//);
  });

  it('rejects a non-POST', async () => {
    const res = mockRes();
    await handlePhotoUpload(await req(true, goodBody, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });

  it('reports a storage failure as recoverable rather than failing the job', async () => {
    putSpy.mockRejectedValueOnce(new Error('blob down'));
    const res = mockRes();
    await handlePhotoUpload(await req(true, goodBody), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.status).toBe('upload_failed');
  });
});
