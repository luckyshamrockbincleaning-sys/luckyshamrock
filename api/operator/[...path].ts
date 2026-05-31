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
 * the tests). This file only parses the path and dispatches.
 */
const VISIT_ACTIONS: Record<string, (req: VercelRequest, res: VercelResponse) => Promise<void>> = {
  notify: handleNotify,
  done: handleDone,
  skip: handleSkip,
  note: handleNote,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const raw = req.query.path;
  const path = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];

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
