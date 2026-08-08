import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  handleLogin,
  handleToday,
  handleUpcoming,
  handleAttention,
  handleHistory,
  handleSeasonStart,
  handleAct,
  handleNewJob,
} from '../../lib/operator-handlers.js';

/**
 * Single-segment operator router. Routes:
 *
 *   POST /api/operator/login
 *   GET  /api/operator/today
 *   GET  /api/operator/upcoming
 *   GET  /api/operator/attention ← done visits whose charge failed
 *   POST /api/operator/act      ← visit actions; body {id, op, text?} (op includes retry)
 *   POST /api/operator/job       ← walk-up: create customer + one-off visit
 *
 * Why one segment: in the Vercel runtime a catch-all `[...path]` route 404'd at
 * the platform for any 2+/-segment URL (e.g. /visit/:id/:action) — the function
 * never ran. The 1-segment dynamic route is the only operator shape proven to
 * reach the function in prod, so visit actions move into the body of /act.
 *
 * Action resolution prefers req.url (req.query.action was observed empty in the
 * runtime); req.query.action is the test-friendly fallback.
 */
// Done generates the wash GIF (sharp + gifenc, ~2-3s) on top of the Stripe
// charge — give it headroom beyond the 10s default.
export const config = { maxDuration: 30 };

const ONE_SEG: Record<string, (req: VercelRequest, res: VercelResponse) => Promise<void>> = {
  login: handleLogin,
  today: handleToday,
  upcoming: handleUpcoming,
  attention: handleAttention,
  history: handleHistory,
  season: handleSeasonStart,
  act: handleAct,
  job: handleNewJob,
};

function resolveAction(req: VercelRequest): string | null {
  if (typeof req.url === 'string' && req.url.length > 0) {
    const pathname = req.url.split('?')[0] ?? '';
    const after = decodeURIComponent(pathname)
      .replace(/^\/+/, '')
      .replace(/^api\/operator\/?/, '');
    const segs = after.split('/').filter(Boolean);
    if (segs.length > 0) return segs[0]!;
  }
  const raw = req.query?.action;
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const action = resolveAction(req);
  const route = action ? ONE_SEG[action] : undefined;
  if (route) return route(req, res);
  res.status(404).json({ status: 'not_found' });
}
