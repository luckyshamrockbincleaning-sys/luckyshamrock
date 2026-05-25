# Lucky Shamrock — repo instructions for Claude Code sessions

## What this repo is

Marketing site + booking system for **Lucky Shamrock Residential Bin Cleaning**
(Fort Saskatchewan). Hosted on Vercel. The customer-facing brand for AB's
BinWash side-business — but built standalone, not on the BinWash Django stack.

## Architecture

- **Static site** at repo root (`index.html` + `app.jsx` + `components-*.jsx` +
  `styles.css`). React via Babel-standalone in the browser. No build step.
- **Serverless API** in `api/`. TypeScript files become Vercel Functions
  (Node 20 runtime).
- **Database** = Neon Postgres. Accessed via `db/client.ts` (lazy singleton).
- **Migrations** = `drizzle-kit` (`npm run db:generate`, `npm run db:push`).
- **Tests** = `vitest`, files live in `**/_tests/*.test.ts`. Env loaded from
  `.env.local` via `dotenv-cli`.

## Common commands

| Command | What it does |
|---|---|
| `npm install` | Install deps |
| `npm run dev` | `vercel dev` — local server with static + functions on :3000 (requires `npx vercel link` first) |
| `npm test` | Run vitest with `.env.local` |
| `npm run typecheck` | Type-only check, no emit |
| `npm run db:generate` | Generate SQL migrations from `db/schema.ts` |
| `npm run db:push` | Apply schema directly to Neon (use for fast dev, not prod) |
| `npx vercel env pull .env.local` | Refresh local env from Vercel |

## Production URLs

- **Site:** https://www.luckyshamrock.ca (apex `luckyshamrock.ca` 307-redirects to www)
- **Vercel preview:** https://luckyshamrock.vercel.app
- **Health check:** https://www.luckyshamrock.ca/api/health

## Working in this repo

- **Don't touch the static site files** (`index.html`, `app.jsx`, `components-*.jsx`,
  `styles.css`) when adding API code. They're served as-is.
- **API files** go in `api/` and become endpoints at `/api/<filename>` (without `.ts`).
  Nested folders work: `api/operator/login.ts` → `POST /api/operator/login`.
- **DB schema changes** require both editing `db/schema.ts` AND running
  `npm run db:push` (or generating + applying a migration). The schema file
  is the source of truth.
- **Tests for `api/foo.ts`** go in `api/_tests/foo.test.ts`. The `_tests/` prefix
  is what vitest matches.
- **Integration tests** (hit real Neon) and **unit tests** (mock the DB via
  `vi.mock('../../db/client.js', ...)`) live side by side. See
  `api/_tests/health.test.ts` (integration) and `api/_tests/health.failure.test.ts`
  (unit) for the pattern.
- **Magic-link secrets, operator password, etc.** live in Vercel env vars,
  not in code. See `.env.example` for the full list. Add new vars in both
  `.env.example` (placeholder, committed) and Vercel dashboard (real value).
- **Postgres driver quirk:** `db/client.ts` sets `ssl: 'require'` explicitly
  because postgres-js's URL parser drops the `sslmode` hint when Neon's
  `channel_binding=require` is also present in the query string. Don't remove
  this line — it's load-bearing for production.

## API response convention

DB-touching endpoints return `{status, db, time, error}` with `error: null`
on success and a string on failure. Protocol-level rejects (e.g., 405 wrong
method) return a separate `{error: '<reason>'}` shape — those aren't health
or business-state assertions and don't carry `time`. See `api/health.ts`
for the reference implementation.

## Active work

Current phase: see `docs/superpowers/plans/` for the most recent dated plan.
Specs: `docs/superpowers/specs/`.

## Related projects

- `~/Documents/binwash` — separate Django SaaS. Lucky Shamrock is its
  customer-facing brand but **not** built on top of it.
- Obsidian project notes: `~/Documents/My Brain/Projects/Lucky Shamrock/`.
