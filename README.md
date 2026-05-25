# Lucky Shamrock — Residential Bin Cleaning

Marketing site + booking system for Lucky Shamrock Bin Cleaning (Fort Saskatchewan).

Hybrid setup: static React (Babel-standalone) marketing site at the root,
TypeScript serverless functions in `api/` for the booking backend,
Postgres via Neon.

**Live:** https://www.luckyshamrock.ca

## Run locally

```bash
npm install
npx vercel link        # one-time, links to the Vercel project
npx vercel env pull .env.local   # pulls DB connection string + secrets
npm run dev            # static site + functions on http://localhost:3000
```

Test the API works:
```bash
curl http://localhost:3000/api/health
# → {"status":"ok","db":true,"time":"...","error":null}
```

## Run tests

```bash
npm test          # one-shot
npm run test:watch
```

Tests run against the real Neon database — `.env.local` must exist
(populated by `vercel env pull`). Unit tests under `api/_tests/*.failure.test.ts`
use mocked DB clients and don't need a live connection.

## Project structure

```
index.html, app.jsx, components-*.jsx, styles.css   # static marketing site
assets/, uploads/                                   # images
api/                                                # Vercel serverless functions (TS)
  _tests/                                           # vitest specs
db/                                                 # postgres + drizzle wrappers
docs/superpowers/specs/                             # design docs
docs/superpowers/plans/                             # implementation plans
CLAUDE.md                                           # instructions for Claude Code
```

## Editable brand details

The Tweaks panel (bottom right of the live site) lets you change city,
phone, and palette without editing code. Defaults live in `app.jsx`
inside the `EDITMODE` block.
