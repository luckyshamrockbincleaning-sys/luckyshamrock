/**
 * Shared test helpers for Vercel function tests.
 *
 * Tests should construct request/response mocks via these factories rather than
 * hand-rolling per test file. The handler's parameter types are recovered via
 * a generic so callers don't have to import @vercel/node types directly.
 */

export type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
};

export function mockReq<H extends (...args: any[]) => any>(
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Parameters<H>[0] {
  const { method = 'GET', body, query = {} } = init;
  return { method, body, query, headers: {} } as unknown as Parameters<H>[0];
}

export function mockRes<H extends (...args: any[]) => any>(): MockRes & Parameters<H>[1] {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res as MockRes & Parameters<H>[1];
}
