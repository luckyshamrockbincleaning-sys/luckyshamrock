import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  handleLogin,
  handleToday,
  handleUpcoming,
  handleNotify,
  handleDone,
  handleSkip,
  handleNote,
} from '../../lib/operator-handlers.js';

/**
 * Catch-all router for every operator endpoint. One Vercel function instead of
 * seven, to stay under Hobby's 12-function-per-deployment limit. Routes:
 *
 *   POST /api/operator/login
 *   GET  /api/operator/today
 *   GET  /api/operator/upcoming
 *   POST /api/operator/visit/:id/{notify,done,skip,note}
 *
 * The real logic lives in lib/operator-handlers.ts (also imported directly by
 * the tests). This file only resolves the path and dispatches.
 *
 * Path resolution prefers req.url: in the Vercel runtime the `[...path]` query
 * param was observed to arrive empty, so relying on it 404'd every route in
 * prod. Parsing the URL is robust; req.query.path remains a fallback so the
 * unit tests (which pass query.path directly) keep working.
 */
const VISIT_ACTIONS: Record<string, (req: VercelRequest, res: VercelResponse) => Promise<void>> = {
  notify: handleNotify,
  done: handleDone,
  skip: handleSkip,
  note: handleNote,
};

function resolvePath(req: VercelRequest): string[] {
  if (typeof req.url === 'string' && req.url.length > 0) {
    const pathname = req.url.split('?')[0] ?? '';
    const after = decodeURIComponent(pathname)
      .replace(/^\/+/, '')
      .replace(/^api\/operator\/?/, '');
    const segs = after.split('/').filter(Boolean);
    if (segs.length > 0) return segs;
  }
  const raw = req.query?.path;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const path = resolvePath(req);

  if (path.length === 1) {
    if (path[0] === 'login') return handleLogin(req, res);
    if (path[0] === 'today') return handleToday(req, res);
    if (path[0] === 'upcoming') return handleUpcoming(req, res);
  }

  if (path.length === 3 && path[0] === 'visit') {
    const action = VISIT_ACTIONS[path[2]!];
    if (action) {
      // Expose the id the way the handlers expect (req.query.id).
      (req.query as Record<string, string | string[]>).id = path[1]!;
      return action(req, res);
    }
  }

  res.status(404).json({ status: 'not_found' });
}
