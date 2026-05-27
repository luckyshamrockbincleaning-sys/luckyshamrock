# Phase 2 — Email + Magic Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed email sender with real Gmail API calls, issue and verify magic-link tokens for passwordless customer auth, and write notification_log rows so every send is idempotent and traceable.

**Architecture:** Service-account JWT → OAuth access token → REST POST to `gmail.googleapis.com` for sending. HMAC-signed session cookies via `jose` (no session DB table). Magic-link tokens: 32 random bytes URL-safe base64, stored hashed in `magic_link_token`, 15-min single-use TTL. The booking-side stubbed `magic_link` email in `/api/book` is replaced with a real token-issuing send. Tests mock `lib/gmail.js` via `vi.mock`; dev without `GMAIL_SERVICE_ACCOUNT_JSON` falls back to console-log stub so local development doesn't need real creds.

**Tech Stack:** Adds `google-auth-library` (OAuth from service account JWT, ~1 MB) + `jose` (HMAC JWT sign/verify, ~50 KB). No template engine — templates are TS functions returning `{subject, html, text}`.

**Decisions locked for this phase:**

1. **OAuth via `google-auth-library` + raw `fetch` to Gmail REST.** The full `googleapis` SDK is ~20 MB and pulls a huge dependency tree; we only need OAuth + one POST. `google-auth-library` alone handles JWT signing + token exchange in ~5 lines.
2. **Session cookies are JWT (HS256) signed with `SESSION_SECRET`.** Carry `{customer_id, exp}`. `jose` does sign + verify. HTTP-only, Secure, SameSite=Lax, path=`/`.
3. **Absolute expiry (30 days), no sliding renewal at Phase 2.** Sliding renewal lands in Phase 3 when `/manage` actually issues authenticated requests.
4. **Magic-link tokens are 32 random bytes (URL-safe base64).** Stored in DB as SHA-256 hash (token never sits in the DB in plaintext). Single-use: `consumed_at` set when verified. 15-min TTL per spec.
5. **`notification_log` writes are always wrapped around sends.** On success, set `sent_at` + `gmail_message_id`. On failure, set `failed_at` + `error`. The `(visit_id, kind)` unique constraint enforces idempotency at the DB layer for visit-bound emails; magic-link rows have `visit_id = NULL` and can be many per customer (each new request is a fresh row).
6. **Dev/test fallback:** if `GMAIL_SERVICE_ACCOUNT_JSON` is unset OR `NODE_ENV === 'test'`, `lib/gmail.ts` returns a synthetic `stub-<uuid>` message ID and prints to `[email:stub]` instead of calling the API. Lets `npm test` and local `vercel dev` work without service-account creds.
7. **Catch unique-violation on `customer.email`** (the Phase 1 final-review prep note) — turn the 500 into a clean 409 with the same `already_subscribed` shape.
8. **Templates inlined as functions** (`lib/email/templates.ts`), not a template engine. Simple `${interpolation}` strings, HTML + plain-text variants.

---

## File Structure

Created in this phase:

```
lib/tokens.ts                       # random token gen + SHA-256 hashing
lib/cookies.ts                      # sign + verify session cookies via jose
lib/gmail.ts                        # OAuth + send raw email via REST
lib/notifications.ts                # wrap sendEmail + write notification_log
lib/email/templates.ts              # four template functions
api/magic-link/send.ts              # POST { email } → issues + emails token
api/magic-link/verify.ts            # GET ?token=...  → sets cookie, redirects

lib/_tests/tokens.test.ts
lib/_tests/cookies.test.ts
lib/_tests/gmail.test.ts            # dev/test stub branch only (no real OAuth)
lib/_tests/templates.test.ts
lib/_tests/notifications.test.ts
api/_tests/magic-link-send.test.ts
api/_tests/magic-link-verify.test.ts
```

Modified in this phase:

```
package.json                        # add google-auth-library, jose
lib/email.ts                        # delegates to lib/gmail.ts (or stub)
api/book.ts                         # uses lib/notifications + real token + 409 on unique-violation
api/_tests/book.test.ts             # update magic_link assertion to expect real token issued
.env.example                        # uncomment + document GMAIL_*, SESSION_SECRET, SITE_URL
CLAUDE.md                           # Phase 2 conventions section
```

Untouched:

```
index.html, app.jsx, components-*.jsx, styles.css, assets/, uploads/
api/health.ts, api/waitlist.ts
db/schema.ts, db/migrations/        # no schema changes in Phase 2
```

**Why no schema changes:** Phase 1 already shipped `magic_link_token` and `notification_log`. Phase 2 just starts writing to them.

---

## Task 1: Manual — Google Workspace service account + domain-wide delegation (AB action)

No code in this task. AB must complete platform setup before any code task can run end-to-end. The implementer should pause and verify these steps are complete before moving on (or move on to test-mockable tasks while AB does this in parallel).

- [ ] **Step 1: Create or pick a Google Cloud project**

AB visits https://console.cloud.google.com. Either pick an existing project or create a new one named `luckyshamrock`. Note the project ID.

- [ ] **Step 2: Enable the Gmail API**

In Cloud Console → APIs & Services → Library → search "Gmail API" → Enable.

- [ ] **Step 3: Create a service account**

In Cloud Console → IAM & Admin → Service Accounts → Create.
- Name: `luckyshamrock-mailer`
- ID: auto-generated, fine
- Description: "Sends transactional email for Lucky Shamrock booking system"
- Role: leave blank (we won't grant Cloud roles; permission comes via Workspace delegation)

- [ ] **Step 4: Generate a JSON key for the service account**

On the service account detail page → Keys → Add Key → Create new key → JSON → Create.
A `.json` file downloads. **Keep this file safe** — it's the credential.

- [ ] **Step 5: Note the service account's `client_id`**

Open the JSON file. Find `client_id` (a long numeric string). Copy it.

- [ ] **Step 6: Enable domain-wide delegation in Workspace**

AB visits https://admin.google.com (must be Workspace super-admin for `luckyshamrock.ca`).
Navigate: Security → Access and data control → API controls → Domain-wide delegation → Add new.
- Client ID: paste from Step 5
- OAuth scopes: `https://www.googleapis.com/auth/gmail.send`
- Authorize.

- [ ] **Step 7: Decide on the sender mailbox**

The service account impersonates a real Workspace user when sending. Pick one:
- `hello@luckyshamrock.ca` (or any other real alias)
- Make sure the mailbox exists in Workspace (or is a verified alias)

- [ ] **Step 8: Verify by sending a test email via OAuth Playground (optional but recommended)**

AB visits https://developers.google.com/oauthplayground, configures the service account, and sends a test "hello world" email to themselves. If this works, domain-wide delegation is set up correctly. If it fails with `unauthorized_client`, re-check the client ID + scopes in Workspace admin.

No commit (platform-only work).

---

## Task 2: Manual — add Phase 2 Vercel env vars (AB action)

No code. AB adds these to Vercel project settings (Settings → Environment Variables):

| Key | Value | Environments |
|---|---|---|
| `SITE_URL` | `https://www.luckyshamrock.ca` | Production, Preview, Development |
| `SESSION_SECRET` | 64-char random string (see Step 1) | Production, Preview, Development |
| `GMAIL_SERVICE_ACCOUNT_JSON` | Full contents of the service-account JSON from Task 1 Step 4 | Production, Preview, Development |
| `GMAIL_SEND_AS` | `hello@luckyshamrock.ca` (Task 1 Step 7) | Production, Preview, Development |

- [ ] **Step 1: Generate the session secret**

```bash
openssl rand -hex 32
```

Copy the 64-char hex string. This is the HMAC key for signed cookies. **Generate fresh — do not reuse across environments.**

- [ ] **Step 2: Add the four env vars**

In Vercel dashboard → luckyshamrock project → Settings → Environment Variables → Add Environment Variable. Use the "paste .env contents" multi-paste form for speed:

```
SITE_URL=https://www.luckyshamrock.ca
SESSION_SECRET=<paste hex from step 1>
GMAIL_SEND_AS=hello@luckyshamrock.ca
```

Then add `GMAIL_SERVICE_ACCOUNT_JSON` separately (the JSON contains literal newlines that the multi-paste parser will mangle). Mark it **Sensitive**.

- [ ] **Step 3: Pull to local**

```bash
cd /Users/homie/Documents/luckyshamrock
npx vercel env pull .env.local
```

- [ ] **Step 4: Sanity check local env**

```bash
node --env-file=.env.local -e "
  const v = ['SITE_URL', 'SESSION_SECRET', 'GMAIL_SEND_AS', 'GMAIL_SERVICE_ACCOUNT_JSON'];
  for (const k of v) console.log(k, ':', process.env[k] ? 'set (' + (process.env[k]?.length || 0) + ' chars)' : 'MISSING');
"
```

Expected: all four print "set" with non-zero char counts. `GMAIL_SERVICE_ACCOUNT_JSON` should be 2000+ chars.

No commit (env files are gitignored).

---

## Task 3: Update `.env.example` for Phase 2

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Read the current file to find the commented Phase 1+ block**

Run: `cat .env.example`
Expected: lines starting with `# SESSION_SECRET=`, `# GMAIL_*`, `# SITE_URL=` etc. are commented out.

- [ ] **Step 2: Uncomment the Phase 2 vars and adjust comments**

Replace the "Phase 1+ vars (left commented for now)" section with:

```env
# ─────────────────────────────────────────────────────────────────────
# Auth + Email (Phase 2)
# ─────────────────────────────────────────────────────────────────────

# Customer session cookie HMAC key (32+ bytes hex, random)
# Generate: openssl rand -hex 32
SESSION_SECRET=

# Google Workspace service account JSON (the full file contents)
# See: docs/superpowers/plans/2026-05-27-phase-2-email-magiclink.md Task 1
GMAIL_SERVICE_ACCOUNT_JSON=

# Workspace mailbox the service account impersonates when sending
GMAIL_SEND_AS=hello@luckyshamrock.ca

# Public base URL — used in email links
SITE_URL=https://www.luckyshamrock.ca

# ─────────────────────────────────────────────────────────────────────
# Phase 3+ vars (left commented for now)
# ─────────────────────────────────────────────────────────────────────

# Operator session cookie HMAC key
# OPERATOR_SECRET=

# Shared operator login password
# OPERATOR_PASSWORD=

# Allowed postal-code prefix (default Fort Saskatchewan)
# SERVICE_POSTAL_PREFIX=T8L

# Available cadences, comma-separated
# SERVICE_CADENCES=monthly,bimonthly,quarterly

# Bin pricing JSON for display
# BIN_PRICES_JSON={"1":{"monthly":22},"2":{"monthly":32},"3":{"monthly":42}}
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document Phase 2 env vars (Gmail + session secret)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `google-auth-library` and `jose` deps

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install both runtime deps**

Run: `npm install google-auth-library@^9 jose@^5`
Expected: `added 2 packages` (plus transitive deps). Both land in `dependencies`.

- [ ] **Step 2: Verify versions in package.json**

```bash
node -e "const p = require('./package.json'); console.log(p.dependencies['google-auth-library'], p.dependencies.jose)"
```

Expected: prints `^9.x.x ^5.x.x` (or similar). NEITHER should be in `devDependencies`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add google-auth-library + jose for Phase 2

google-auth-library handles service-account JWT → OAuth token exchange
for the Gmail API. jose signs the customer session cookies (HS256 JWTs).
Both are pure-ESM, small, and Vercel-runtime compatible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `lib/tokens.ts` — random token gen + SHA-256 hashing (TDD)

**Files:**
- Create: `lib/tokens.ts`, `lib/_tests/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/tokens.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMagicLinkToken, hashToken } from '../tokens.js';

describe('generateMagicLinkToken', () => {
  it('returns a 43-char URL-safe base64 string (32 bytes encoded)', () => {
    const token = generateMagicLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns a different value on every call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateMagicLinkToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('hashToken', () => {
  it('returns a 64-char lowercase hex SHA-256 hash', () => {
    const hash = hashToken('any-input');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashToken('same')).toBe(hashToken('same'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- lib/_tests/tokens.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `lib/tokens.ts`**

```typescript
import { randomBytes, createHash } from 'node:crypto';

/**
 * Generate a fresh magic-link token. 32 random bytes encoded as URL-safe
 * base64 (no padding) = 43 chars. The plaintext token is what we email to
 * the customer; only its hash is stored in the DB.
 */
export function generateMagicLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Deterministic SHA-256 hash of a token. Used to store tokens in the DB
 * without storing the plaintext — a DB leak alone can't grant access.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Run — expect PASS (5 tests)**

Run: `npm test -- lib/_tests/tokens.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/tokens.ts lib/_tests/tokens.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add magic-link token generation + hashing

generateMagicLinkToken() returns 32 random bytes URL-safe base64 encoded
(43 chars). hashToken() SHA-256s the plaintext; only the hash is stored
in magic_link_token rows, so a DB leak alone cannot grant access.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `lib/cookies.ts` — sign/verify session cookies (TDD)

**Files:**
- Create: `lib/cookies.ts`, `lib/_tests/cookies.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/cookies.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  signSessionCookie,
  verifySessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from '../cookies.js';

const TEST_SECRET = 'a'.repeat(64);

beforeAll(() => {
  process.env.SESSION_SECRET = TEST_SECRET;
});

describe('SESSION_COOKIE_NAME', () => {
  it('is "ls_session"', () => {
    expect(SESSION_COOKIE_NAME).toBe('ls_session');
  });
});

describe('SESSION_TTL_SECONDS', () => {
  it('is 30 days in seconds', () => {
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('signSessionCookie + verifySessionCookie', () => {
  it('round-trips a customer id', async () => {
    const token = await signSessionCookie('cust-123');
    const payload = await verifySessionCookie(token);
    expect(payload?.customerId).toBe('cust-123');
  });

  it('returns null for a tampered token', async () => {
    const token = await signSessionCookie('cust-123');
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(await verifySessionCookie(tampered)).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await signSessionCookie('cust-123');
    process.env.SESSION_SECRET = 'b'.repeat(64);
    expect(await verifySessionCookie(token)).toBeNull();
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  it('returns null for garbage input', async () => {
    expect(await verifySessionCookie('not-a-jwt')).toBeNull();
    expect(await verifySessionCookie('')).toBeNull();
  });

  it('throws if SESSION_SECRET is unset when signing', async () => {
    const prev = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    await expect(signSessionCookie('cust-123')).rejects.toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = prev;
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- lib/_tests/cookies.test.ts`

- [ ] **Step 3: Implement `lib/cookies.ts`**

```typescript
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'ls_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface SessionPayload {
  customerId: string;
}

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) {
    throw new Error('SESSION_SECRET is not set');
  }
  return new TextEncoder().encode(raw);
}

export async function signSessionCookie(customerId: string): Promise<string> {
  const secret = getSecret();
  return await new SignJWT({ customerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySessionCookie(token: string): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.customerId !== 'string') return null;
    return { customerId: payload.customerId };
  } catch {
    return null;
  }
}

/**
 * Format the cookie for a Set-Cookie header. HTTP-only, Secure, SameSite=Lax.
 */
export function formatSessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

/**
 * Cookie header value that immediately expires the session cookie. For logout.
 */
export function formatClearSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}
```

- [ ] **Step 4: Run — expect PASS (8 tests)**

Run: `npm test -- lib/_tests/cookies.test.ts`
Expected: 8 tests passing (1 + 1 + 6 in three describes).

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/cookies.ts lib/_tests/cookies.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add HMAC-signed session cookies via jose

signSessionCookie + verifySessionCookie round-trip { customerId } in an
HS256 JWT keyed by SESSION_SECRET. Cookie is HTTP-only, Secure, SameSite=Lax,
30-day absolute expiry. Tampered tokens, wrong-secret tokens, garbage input
all verify as null (never throw).

formatSessionCookieHeader / formatClearSessionCookieHeader produce the
Set-Cookie strings; verify endpoints attach the first, logout (Phase 3)
attaches the second.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `lib/email/templates.ts` — four templates (TDD)

**Files:**
- Create: `lib/email/templates.ts`, `lib/_tests/templates.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  bookingConfirmedTemplate,
  magicLinkTemplate,
  onOurWayTemplate,
  doneTemplate,
} from '../email/templates.js';

describe('bookingConfirmedTemplate', () => {
  it('mentions the first visit date in subject and body', () => {
    const t = bookingConfirmedTemplate({
      name: 'Sam',
      firstVisitDate: '2026-06-04',
      manageUrl: 'https://example.com/manage?token=abc',
    });
    expect(t.subject).toMatch(/Lucky Shamrock/i);
    expect(t.text).toContain('2026-06-04');
    expect(t.text).toContain('Sam');
    expect(t.text).toContain('https://example.com/manage?token=abc');
    expect(t.html).toContain('2026-06-04');
  });
});

describe('magicLinkTemplate', () => {
  it('includes the manage URL prominently', () => {
    const t = magicLinkTemplate({
      manageUrl: 'https://example.com/manage?token=xyz',
    });
    expect(t.subject).toMatch(/manage/i);
    expect(t.text).toContain('https://example.com/manage?token=xyz');
    expect(t.html).toContain('https://example.com/manage?token=xyz');
  });
});

describe('onOurWayTemplate', () => {
  it('tells the customer the operator is on the way', () => {
    const t = onOurWayTemplate({ name: 'Sam' });
    expect(t.subject).toMatch(/way/i);
    expect(t.text).toContain('Sam');
    expect(t.text).toMatch(/way|cleaning|heading/i);
  });
});

describe('doneTemplate', () => {
  it('confirms the clean and mentions the next visit when present', () => {
    const withNext = doneTemplate({ name: 'Sam', nextVisitDate: '2026-06-11' });
    expect(withNext.subject).toMatch(/done|clean|complete/i);
    expect(withNext.text).toContain('Sam');
    expect(withNext.text).toContain('2026-06-11');

    const withoutNext = doneTemplate({ name: 'Sam', nextVisitDate: null });
    expect(withoutNext.text).toContain('Sam');
    expect(withoutNext.text).not.toContain('Next clean');
  });
});

describe('all templates produce non-empty html and text', () => {
  it.each([
    ['bookingConfirmed', bookingConfirmedTemplate({ name: 'X', firstVisitDate: '2026-01-01', manageUrl: 'https://x.com' })],
    ['magicLink', magicLinkTemplate({ manageUrl: 'https://x.com' })],
    ['onOurWay', onOurWayTemplate({ name: 'X' })],
    ['done', doneTemplate({ name: 'X', nextVisitDate: null })],
  ])('%s', (_name, t) => {
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text.length).toBeGreaterThan(0);
    expect(t.html.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- lib/_tests/templates.test.ts`

- [ ] **Step 3: Implement `lib/email/templates.ts`**

```typescript
/**
 * Email templates for Phase 2. Each export is a pure function returning
 * { subject, html, text }. HTML is intentionally minimal — focused on
 * readability across mail clients, not visual design.
 *
 * Templates live in one file because none are big enough to warrant their
 * own. If any grows past ~40 lines, split it out.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const FOOTER_HTML = '<p style="color:#888;font-size:12px;margin-top:32px">Lucky Shamrock Bin Cleaning · Fort Saskatchewan</p>';
const FOOTER_TEXT = '--\nLucky Shamrock Bin Cleaning · Fort Saskatchewan';

export function bookingConfirmedTemplate(p: {
  name: string;
  firstVisitDate: string;
  manageUrl: string;
}): RenderedEmail {
  const subject = `You're booked with Lucky Shamrock`;
  const text =
    `Hi ${p.name},\n\n` +
    `You're confirmed. Your first clean is scheduled for ${p.firstVisitDate}.\n\n` +
    `Manage your booking: ${p.manageUrl}\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>You're confirmed. Your first clean is scheduled for <strong>${escapeHtml(p.firstVisitDate)}</strong>.</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}">Manage your booking</a></p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function magicLinkTemplate(p: { manageUrl: string }): RenderedEmail {
  const subject = `Your Lucky Shamrock manage link`;
  const text =
    `Click to manage your booking (link expires in 15 minutes):\n\n${p.manageUrl}\n\n` +
    `If you didn't request this, ignore this email.\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Click to manage your booking (link expires in 15 minutes):</p>` +
    `<p><a href="${escapeAttr(p.manageUrl)}">${escapeHtml(p.manageUrl)}</a></p>` +
    `<p style="color:#666">If you didn't request this, ignore this email.</p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function onOurWayTemplate(p: { name: string }): RenderedEmail {
  const subject = `We're on the way`;
  const text =
    `Hi ${p.name},\n\n` +
    `Lucky Shamrock is heading to your bins now. We'll be in and out — no need to be home.\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Lucky Shamrock is heading to your bins now. We'll be in and out — no need to be home.</p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

export function doneTemplate(p: { name: string; nextVisitDate: string | null }): RenderedEmail {
  const subject = `Your bins are clean`;
  const nextLine = p.nextVisitDate ? `Next clean: ${p.nextVisitDate}.` : `That was your last scheduled clean.`;
  const text =
    `Hi ${p.name},\n\n` +
    `Bins cleaned. ${nextLine}\n\n` +
    FOOTER_TEXT;
  const html =
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Bins cleaned. ${escapeHtml(nextLine)}</p>` +
    FOOTER_HTML;
  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (intentionally simple — no general-purpose escape lib)
// ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
```

- [ ] **Step 4: Run — expect PASS (~8 tests)**

Run: `npm test -- lib/_tests/templates.test.ts`
Expected: 8 tests passing (1 + 1 + 1 + 1 + 4 from `it.each`).

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/email/templates.ts lib/_tests/templates.test.ts
git commit -m "$(cat <<'EOF'
feat(email): add four email templates for Phase 2

bookingConfirmedTemplate, magicLinkTemplate, onOurWayTemplate, doneTemplate
each return {subject, html, text}. HTML escaping is hand-rolled (5 chars,
no library dep). day_before reminder template is deferred to Phase 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `lib/gmail.ts` — Gmail API send via service account (TDD on stub branch)

**Files:**
- Create: `lib/gmail.ts`, `lib/_tests/gmail.test.ts`

The real send branch can't be unit-tested without live Workspace credentials. We TDD the dev/test stub path and prove the OAuth path is wired correctly via an integration smoke test in Task 15.

- [ ] **Step 1: Write the failing test**

`lib/_tests/gmail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendViaGmail, isGmailConfigured } from '../gmail.js';

describe('isGmailConfigured', () => {
  it('is false when GMAIL_SERVICE_ACCOUNT_JSON is unset', () => {
    const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    expect(isGmailConfigured()).toBe(false);
    if (prev !== undefined) process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });

  it('is true when GMAIL_SERVICE_ACCOUNT_JSON is set', () => {
    const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = '{}';
    expect(isGmailConfigured()).toBe(true);
    if (prev === undefined) delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    else process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });
});

describe('sendViaGmail — stub branch (no GMAIL_SERVICE_ACCOUNT_JSON)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;

  beforeEach(() => {
    delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (prev !== undefined) process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });

  it('returns ok=true and a stub-<uuid> message id', async () => {
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: '<p>t</p>' });
    expect(r.ok).toBe(true);
    expect(r.gmailMessageId).toMatch(/^stub-[a-f0-9-]{36}$/);
  });

  it('logs the payload via [email:stub] tag', async () => {
    await sendViaGmail({ to: 'sam@example.com', subject: 'hi', text: 'body', html: '<b>body</b>' });
    expect(logSpy).toHaveBeenCalledWith('[email:stub]', expect.objectContaining({
      to: 'sam@example.com',
      subject: 'hi',
    }));
  });

  it('rejects malformed recipient even in stub mode', async () => {
    const r = await sendViaGmail({ to: 'not-an-email', subject: '', text: '', html: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid recipient/i);
  });
});

describe('sendViaGmail — real branch entry conditions', () => {
  beforeEach(() => {
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = '{"client_email":"x@y.iam","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----"}';
    process.env.GMAIL_SEND_AS = 'hello@luckyshamrock.ca';
  });

  it('errors clearly when GMAIL_SEND_AS is missing', async () => {
    delete process.env.GMAIL_SEND_AS;
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: 'h' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GMAIL_SEND_AS/);
  });

  it('errors clearly when service account JSON is unparseable', async () => {
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = 'not-json';
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: 'h' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GMAIL_SERVICE_ACCOUNT_JSON/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- lib/_tests/gmail.test.ts`

- [ ] **Step 3: Implement `lib/gmail.ts`**

```typescript
import { JWT } from 'google-auth-library';

export interface SendGmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendGmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isGmailConfigured(): boolean {
  return typeof process.env.GMAIL_SERVICE_ACCOUNT_JSON === 'string' && process.env.GMAIL_SERVICE_ACCOUNT_JSON.length > 0;
}

export async function sendViaGmail(input: SendGmailInput): Promise<SendGmailResult> {
  if (!SIMPLE_EMAIL_RE.test(input.to)) {
    return { ok: false, error: `invalid recipient: ${input.to}` };
  }

  if (!isGmailConfigured()) {
    // Dev/test fallback: log and return synthetic message id
    console.log('[email:stub]', {
      to: input.to,
      subject: input.subject,
      bodyPreview: input.text.slice(0, 80),
    });
    return { ok: true, gmailMessageId: `stub-${crypto.randomUUID()}` };
  }

  const sendAs = process.env.GMAIL_SEND_AS;
  if (!sendAs) {
    return { ok: false, error: 'GMAIL_SEND_AS is not set' };
  }

  let creds: { client_email: string; private_key: string };
  try {
    creds = JSON.parse(process.env.GMAIL_SERVICE_ACCOUNT_JSON!);
    if (!creds.client_email || !creds.private_key) {
      return { ok: false, error: 'GMAIL_SERVICE_ACCOUNT_JSON missing client_email or private_key' };
    }
  } catch (err) {
    return { ok: false, error: `GMAIL_SERVICE_ACCOUNT_JSON is not valid JSON: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: sendAs,
    });
    const tokenResponse = await auth.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) {
      return { ok: false, error: 'no access token returned by Google' };
    }

    const raw = buildRfc822Message({ from: sendAs, ...input });
    const encoded = Buffer.from(raw, 'utf-8').toString('base64url');

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sendAs)}/messages/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `gmail API ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = (await resp.json()) as { id?: string };
    return { ok: true, gmailMessageId: data.id ?? null ?? undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown gmail error' };
  }
}

function buildRfc822Message(p: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `boundary_${crypto.randomUUID()}`;
  return [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${encodeSubject(p.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.html,
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word for non-ASCII safety. For ASCII this is a no-op.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}
```

- [ ] **Step 4: Run — expect PASS (~7 tests)**

Run: `npm test -- lib/_tests/gmail.test.ts`
Expected: 7 tests passing (2 + 3 + 2 in three describes).

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/gmail.ts lib/_tests/gmail.test.ts
git commit -m "$(cat <<'EOF'
feat(email): add Gmail API client with service-account auth

sendViaGmail() does service-account JWT → OAuth token → REST POST to
gmail.googleapis.com. Falls back to console-log stub when
GMAIL_SERVICE_ACCOUNT_JSON is unset (local dev / test).

Tests cover the stub branch and the env-var validation paths
(missing GMAIL_SEND_AS, malformed JSON). The live OAuth path is
exercised by the production smoke test in Task 15 of the plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Refactor `lib/email.ts` to delegate to `lib/gmail.ts`

**Files:**
- Modify: `lib/email.ts`

The old `lib/email.ts` (Phase 1 stub) had its own hand-rolled console.log. Now `lib/gmail.ts` owns the stub branch. `lib/email.ts` becomes a thin compatibility layer that the rest of the codebase can keep calling unchanged.

- [ ] **Step 1: Read the current file**

Run: `cat lib/email.ts`
Confirm it exports `sendEmail`, `EmailKind`, `SendEmailInput`, `SendEmailResult`.

- [ ] **Step 2: Replace the body**

Replace `lib/email.ts` with:

```typescript
/**
 * Email sender entrypoint. Delegates to lib/gmail.ts (real OAuth + Gmail
 * REST when GMAIL_SERVICE_ACCOUNT_JSON is set, otherwise a console-log
 * stub). Signature and result shape are stable across Phase 1 and Phase 2.
 */

import { sendViaGmail, type SendGmailResult } from './gmail.js';

export type EmailKind =
  | 'magic_link'
  | 'booking_confirmed'
  | 'on_our_way'
  | 'done'
  | 'day_before';

export interface SendEmailInput {
  kind: EmailKind;
  to: string;
  subject: string;
  /** Plain-text body. */
  body: string;
  /** Optional HTML body. If absent, body is wrapped in <pre>. */
  html?: string;
}

export interface SendEmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const html = input.html ?? `<pre>${escapeHtml(input.body)}</pre>`;
  const result: SendGmailResult = await sendViaGmail({
    to: input.to,
    subject: input.subject,
    text: input.body,
    html,
  });
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 3: Re-run the email tests from Phase 1**

Run: `npm test -- lib/_tests/email.test.ts`
Expected: the original 4 tests still pass. The `gmailMessageId` regex still matches `stub-<uuid>` (because lib/gmail.ts's stub returns the same shape). The "logs payload" test still sees `[email:stub]` (because the log moved into lib/gmail.ts but the tag is unchanged).

If any test fails, the most likely cause is the email-input now passes a separate `html` field that the stub doesn't log. Update the test if needed; the spec just requires the log includes `to/subject/kind` — `kind` is no longer passed to gmail, so the test's `expect.objectContaining({kind: ...})` will fail.

**Action:** if the old test asserts `kind` in the log payload, drop that assertion. `kind` is a sender-layer concept; the gmail-layer log doesn't carry it. The test should now look for `to/subject` only.

Update `lib/_tests/email.test.ts` if needed — read it and remove any assertion that no longer applies. The 4-test count should be preserved.

- [ ] **Step 4: Run the full lib test suite**

Run: `npm test -- lib/_tests/`
Expected: postal (5) + schedule (11) + validation (14) + email (4) + tokens (5) + cookies (8) + templates (8) + gmail (7) = 62 lib tests passing.

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts lib/_tests/email.test.ts
git commit -m "$(cat <<'EOF'
refactor(email): delegate sendEmail to lib/gmail.ts

lib/email.ts is now a thin facade: it accepts {kind, to, subject, body,
html?} and forwards to sendViaGmail(). Signature is backward-compatible
with Phase 1 callers in api/book.ts. The console-log stub now lives in
lib/gmail.ts so the dev fallback is the same regardless of which layer
initiates the send.

Test updated to drop the kind-in-log assertion: kind is a sender-layer
concept and no longer appears in the gmail-layer log line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `lib/notifications.ts` — wrap send + write notification_log (TDD)

**Files:**
- Create: `lib/notifications.ts`, `lib/_tests/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/notifications.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- lib/_tests/notifications.test.ts`

- [ ] **Step 3: Implement `lib/notifications.ts`**

```typescript
import { and, eq, isNotNull } from 'drizzle-orm';
import { sendEmail, type EmailKind } from './email.js';
import { getDb } from '../db/client.js';
import { notificationLog } from '../db/schema.js';

export interface SendAndLogInput {
  kind: EmailKind;
  to: string;
  subject: string;
  body: string;
  html?: string;
  customerId: string;
  /** Null for non-visit-bound emails (magic_link). */
  visitId: string | null;
}

export interface SendAndLogResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
  /** True if the send was skipped due to an existing log row. */
  skipped?: boolean;
}

/**
 * Wraps sendEmail with notification_log idempotency + record-keeping.
 *
 * For visit-bound emails (visitId is not null), checks for a prior
 * notification_log row with the same (visitId, kind). If found, skips
 * the send and returns { ok: true, skipped: true }.
 *
 * Magic-link emails have visitId=null; the unique constraint allows
 * many rows per customer, so we always send.
 */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogResult> {
  const db = getDb();

  if (input.visitId !== null) {
    const prior = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.visitId, input.visitId), eq(notificationLog.kind, input.kind)));
    if (prior.length > 0) {
      return { ok: true, skipped: true };
    }
  }

  const sendResult = await sendEmail({
    kind: input.kind,
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html,
  });

  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    customerId: input.customerId,
    visitId: input.visitId,
    kind: input.kind,
    gmailMessageId: sendResult.gmailMessageId,
  };
  if (sendResult.ok) {
    row.sentAt = new Date();
  } else {
    row.failedAt = new Date();
    row.error = sendResult.error;
  }

  await db.insert(notificationLog).values(row as any);

  return {
    ok: sendResult.ok,
    gmailMessageId: sendResult.gmailMessageId,
    error: sendResult.error,
  };
}
```

- [ ] **Step 4: Run — expect PASS (4 tests)**

Run: `npm test -- lib/_tests/notifications.test.ts`

Note: the test mocks both `lib/email.js` and `db/client.js`. The mocks must be set up via `vi.mock` BEFORE the dynamic `await import('../notifications.js')`. This is the same pattern as `health.failure.test.ts`.

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add lib/notifications.ts lib/_tests/notifications.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add sendAndLog — email + notification_log wrapper

For visit-bound emails (visit_id is not null), checks notification_log
for an existing (visit_id, kind) row first; returns { ok, skipped: true }
without sending if found. This is the Phase 1 final-review prep item.

For magic-link emails (visit_id is null), always sends — the table's
unique constraint treats NULL as distinct, so many rows per customer
is the intended behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `POST /api/magic-link/send` (TDD)

**Files:**
- Create: `api/magic-link/send.ts`, `api/_tests/magic-link-send.test.ts`

- [ ] **Step 1: Write the failing test**

`api/_tests/magic-link-send.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../magic-link/send.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
});

beforeEach(async () => {
  await truncateAllForTests();
});

async function makeCustomer(email: string): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(customer).values({
    id,
    email,
    name: 'Test',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  return id;
}

describe('POST /api/magic-link/send', () => {
  it('issues a token row and returns 200 + ok shape for an existing customer', async () => {
    const customerId = await makeCustomer('sam@example.com');

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'sam@example.com' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).status).toBe('ok');

    const db = getDb();
    const tokens = await db.select().from(magicLinkToken).where(eq(magicLinkToken.customerId, customerId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).toBeNull();
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does NOT leak whether the email exists (always returns 200/ok)', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).status).toBe('ok');

    const db = getDb();
    const tokens = await db.select().from(magicLinkToken);
    expect(tokens).toHaveLength(0);
  });

  it('returns 400 for invalid body', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'not-an-email' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- api/_tests/magic-link-send.test.ts`

- [ ] **Step 3: Implement `api/magic-link/send.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { generateMagicLinkToken, hashToken } from '../../lib/tokens.js';
import { sendAndLog } from '../../lib/notifications.js';
import { magicLinkTemplate } from '../../lib/email/templates.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';

  try {
    const db = getDb();
    const [existing] = await db.select().from(customer).where(eq(customer.email, parsed.data.email));

    if (!existing) {
      // Do not leak whether the email exists. Pretend success.
      res.status(200).json({ status: 'ok' });
      return;
    }

    const token = generateMagicLinkToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await db.insert(magicLinkToken).values({
      token: tokenHash,
      customerId: existing.id,
      expiresAt,
    });

    const manageUrl = `${siteUrl}/api/magic-link/verify?token=${encodeURIComponent(token)}`;
    const rendered = magicLinkTemplate({ manageUrl });

    await sendAndLog({
      kind: 'magic_link',
      to: parsed.data.email,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      customerId: existing.id,
      visitId: null,
    });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[magic-link/send] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
```

- [ ] **Step 4: Run — expect PASS (4 tests)**

Run: `npm test -- api/_tests/magic-link-send.test.ts`

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add api/magic-link/send.ts api/_tests/magic-link-send.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /api/magic-link/send — issue + email a token

Generates a 32-byte URL-safe token, stores its SHA-256 hash in
magic_link_token with 15-min TTL, emails the plaintext to the
recipient via the magicLinkTemplate.

Always returns 200/ok regardless of whether the email exists, to
prevent customer enumeration. The token+email path only runs when
the customer actually exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `GET /api/magic-link/verify` (TDD)

**Files:**
- Create: `api/magic-link/verify.ts`, `api/_tests/magic-link-verify.test.ts`

- [ ] **Step 1: Write the failing test**

`api/_tests/magic-link-verify.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../magic-link/verify.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashToken } from '../../lib/tokens.js';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '../../lib/cookies.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

beforeEach(async () => {
  await truncateAllForTests();
});

async function makeCustomerAndToken(email: string, tokenPlain: string, opts: { expiresMinutesFromNow?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(customer).values({
    id,
    email,
    name: 'Test',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  await db.insert(magicLinkToken).values({
    token: hashToken(tokenPlain),
    customerId: id,
    expiresAt: new Date(Date.now() + (opts.expiresMinutesFromNow ?? 15) * 60_000),
  });
  return id;
}

// mockReq from _helpers uses { method, body, query, headers }. We extend for setHeader on res.
function mockResWithHeaders() {
  const headers: Record<string, string | string[]> = {};
  const res: any = {
    statusCode: 200,
    headers,
    body: undefined,
    redirected: null as string | null,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string | string[]) { headers[name] = value; return this; },
    redirect(code: number | string, url?: string) {
      // Vercel supports both res.redirect(url) and res.redirect(status, url)
      if (typeof code === 'string') { this.statusCode = 302; this.redirected = code; }
      else { this.statusCode = code; this.redirected = url ?? null; }
      return this;
    },
  };
  return res;
}

describe('GET /api/magic-link/verify', () => {
  it('redirects to /manage and sets a session cookie for a valid token', async () => {
    const customerId = await makeCustomerAndToken('sam@example.com', 'plain-token-abc');

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'plain-token-abc' } });
    const res = mockResWithHeaders();
    await handler(req, res);

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.redirected).toBe('/manage');

    const cookieHeader = res.headers['Set-Cookie'];
    expect(cookieHeader).toBeDefined();
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0]! : cookieHeader as string;
    expect(cookieStr).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Secure');

    const jwt = cookieStr.split(';')[0]!.split('=')[1]!;
    const payload = await verifySessionCookie(jwt);
    expect(payload?.customerId).toBe(customerId);

    const db = getDb();
    const [t] = await db.select().from(magicLinkToken);
    expect(t!.consumedAt).not.toBeNull();
  });

  it('returns 400 when token is missing', async () => {
    const req = mockReq<typeof handler>({ method: 'GET', query: {} });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token does not exist', async () => {
    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'nonexistent' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token is already consumed', async () => {
    await makeCustomerAndToken('sam@example.com', 'used-token');
    const db = getDb();
    await db.update(magicLinkToken).set({ consumedAt: new Date() }).where(eq(magicLinkToken.token, hashToken('used-token')));

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'used-token' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token has expired', async () => {
    await makeCustomerAndToken('sam@example.com', 'expired-token', { expiresMinutesFromNow: -1 });

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'expired-token' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-GET', async () => {
    const req = mockReq<typeof handler>({ method: 'POST' });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- api/_tests/magic-link-verify.test.ts`

- [ ] **Step 3: Implement `api/magic-link/verify.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { magicLinkToken } from '../../db/schema.js';
import { hashToken } from '../../lib/tokens.js';
import { signSessionCookie, formatSessionCookieHeader } from '../../lib/cookies.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const tokenParam = typeof req.query.token === 'string' ? req.query.token : null;
  if (!tokenParam) {
    res.status(400).json({ status: 'invalid', message: 'missing token' });
    return;
  }

  try {
    const db = getDb();
    const tokenHash = hashToken(tokenParam);
    const [row] = await db.select().from(magicLinkToken).where(eq(magicLinkToken.token, tokenHash));

    if (!row) {
      res.status(400).json({ status: 'invalid', message: 'token not found' });
      return;
    }
    if (row.consumedAt !== null) {
      res.status(400).json({ status: 'invalid', message: 'token already used' });
      return;
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      res.status(400).json({ status: 'invalid', message: 'token expired' });
      return;
    }

    // Mark consumed
    await db.update(magicLinkToken).set({ consumedAt: new Date() }).where(eq(magicLinkToken.token, tokenHash));

    // Issue session cookie and redirect
    const sessionToken = await signSessionCookie(row.customerId);
    res.setHeader('Set-Cookie', formatSessionCookieHeader(sessionToken));
    res.redirect('/manage');
  } catch (err) {
    console.error('[magic-link/verify] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
```

- [ ] **Step 4: Run — expect PASS (6 tests)**

Run: `npm test -- api/_tests/magic-link-verify.test.ts`

- [ ] **Step 5: Typecheck — exit 0**

- [ ] **Step 6: Commit**

```bash
git add api/magic-link/verify.ts api/_tests/magic-link-verify.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/magic-link/verify — consume token + set session

Hashes the incoming plaintext token, looks up the row, rejects with 400
if not found / already consumed / expired. On success: sets consumed_at,
signs a 30-day JWT session cookie (HS256 via jose), and redirects to
/manage. The /manage page itself lands in Phase 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire `/api/book` to use real magic link + sendAndLog + 409 on unique-violation

**Files:**
- Modify: `api/book.ts`
- Modify: `api/_tests/book.test.ts`

- [ ] **Step 1: Read the current `api/book.ts` to confirm structure**

Run: `cat api/book.ts`
Note where the stubbed `sendEmail({ kind: 'magic_link', body: '...?token=PLACEHOLDER' })` call is.

- [ ] **Step 2: Replace the placeholder send section with real token issuance**

Apply these changes inside `api/book.ts`:

Replace the imports section:
```typescript
import { sendEmail } from '../lib/email.js';
```
with:
```typescript
import { sendAndLog } from '../lib/notifications.js';
import { bookingConfirmedTemplate, magicLinkTemplate } from '../lib/email/templates.js';
import { generateMagicLinkToken, hashToken } from '../lib/tokens.js';
import { magicLinkToken } from '../db/schema.js';
```

Adjust the schema imports at the top so `magicLinkToken` joins `customer, subscription, visit`:
```typescript
import { customer, subscription, visit, magicLinkToken } from '../db/schema.js';
```

**Refactor the visit insert** so visit IDs are captured deterministically (the current `api/book.ts` inlines the IDs inside the `db.insert(visit).values(...)` call, so they're not accessible afterward). Build the rows first, then insert:

```typescript
const visitRows = visitDates.map((scheduledFor) => ({
  id: crypto.randomUUID(),
  customerId,
  subscriptionId,
  scheduledFor,
}));
await db.insert(visit).values(visitRows);
const firstVisitId = visitRows[0]?.id ?? null;
```

Then replace the email-sending block (currently calls `sendEmail` twice with raw strings) with:

```typescript
const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';

// Issue a fresh magic-link token
const tokenPlain = generateMagicLinkToken();
await db.insert(magicLinkToken).values({
  token: hashToken(tokenPlain),
  customerId,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
});
const manageUrl = `${siteUrl}/api/magic-link/verify?token=${encodeURIComponent(tokenPlain)}`;

// Send booking_confirmed — idempotent on (firstVisitId, 'booking_confirmed')
const bookingTemplate = bookingConfirmedTemplate({
  name: data.name,
  firstVisitDate,
  manageUrl,
});
await sendAndLog({
  kind: 'booking_confirmed',
  to: data.email,
  subject: bookingTemplate.subject,
  body: bookingTemplate.text,
  html: bookingTemplate.html,
  customerId,
  visitId: firstVisitId,
});

// Send magic_link — visitId: null, no idempotency check (each booking issues a fresh token)
const mlTemplate = magicLinkTemplate({ manageUrl });
await sendAndLog({
  kind: 'magic_link',
  to: data.email,
  subject: mlTemplate.subject,
  body: mlTemplate.text,
  html: mlTemplate.html,
  customerId,
  visitId: null,
});
```

Then catch unique-violation in the outer `try`/`catch`. Replace the existing catch with:

```typescript
} catch (err) {
  // Postgres unique_violation = SQLSTATE 23505. Drizzle surfaces this in
  // err.code or err.constraint depending on driver version; postgres-js
  // attaches it on err.code as '23505'.
  const code = (err as { code?: string } | undefined)?.code;
  if (code === '23505') {
    res.status(409).json({
      status: 'already_subscribed',
      message: 'This email is already on our system. Request a manage link instead.',
    });
    return;
  }
  console.error('[book] failed', err);
  const message = err instanceof Error ? err.message : 'unknown_error';
  res.status(500).json({ status: 'error', message });
}
```

- [ ] **Step 3: Update `api/_tests/book.test.ts` to reflect the new flow**

The book test currently doesn't assert anything about magic_link tokens or notification_log. Add at the end of the file (inside the existing `describe`):

```typescript
import { magicLinkToken, notificationLog } from '../../db/schema.js';

it('issues a magic_link_token and writes notification_log rows on success', async () => {
  const req = mockReq<typeof handler>({
    method: 'POST',
    body: { ...validBody, plan: 'monthly' },
  });
  const res = mockRes<typeof handler>();
  await handler(req, res);
  expect(res.statusCode).toBe(200);

  const db = getDb();
  const tokens = await db.select().from(magicLinkToken);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.consumedAt).toBeNull();

  const logs = await db.select().from(notificationLog);
  expect(logs.length).toBeGreaterThanOrEqual(2);
  const kinds = new Set(logs.map((l) => l.kind));
  expect(kinds.has('booking_confirmed')).toBe(true);
  expect(kinds.has('magic_link')).toBe(true);
});
```

Add the imports for `magicLinkToken` and `notificationLog` at the top of the test file (they may not yet be imported).

- [ ] **Step 4: Run — book tests should all pass**

Run: `npm test -- api/_tests/book.test.ts`
Expected: 4 tests passing (3 original + 1 new).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 49 (Phase 1) + 5 (tokens) + 8 (cookies) + 8 (templates) + 7 (gmail) + 4 (notifications) + 4 (magic-link/send) + 6 (magic-link/verify) + 1 (new book) = 92 tests.

If a number is different, recount; the goal is "no regressions and the new tests all pass." Don't panic on off-by-one.

- [ ] **Step 6: Typecheck — exit 0**

- [ ] **Step 7: Commit**

```bash
git add api/book.ts api/_tests/book.test.ts
git commit -m "$(cat <<'EOF'
feat(api): wire /api/book to real magic-link + sendAndLog

Replaces the Phase 1 placeholder magic_link email with a real
token-issuing flow: generates a 32-byte token, stores its hash in
magic_link_token, emails the plaintext via magicLinkTemplate, all
through sendAndLog so notification_log gets the row.

booking_confirmed email is now idempotent on (first_visit_id,
'booking_confirmed') — a retry that lands the same customer row
won't double-send.

Catches Postgres 23505 (unique_violation) on customer.email and
returns 409 'already_subscribed' instead of a generic 500.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Update CLAUDE.md with Phase 2 conventions

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append a new section AFTER "Booking endpoint conventions"**

```markdown
## Auth + email conventions (Phase 2+)

- **Session cookies** are HS256 JWTs signed with `SESSION_SECRET`. Use `signSessionCookie` / `verifySessionCookie` from `lib/cookies.ts`. Cookie name: `ls_session`. 30-day absolute TTL. HTTP-only, Secure, SameSite=Lax. Sliding renewal lives in Phase 3.
- **Magic-link tokens** are 32 random bytes URL-safe base64. Always email the plaintext; store the SHA-256 hash via `hashToken()` from `lib/tokens.ts`. 15-min TTL, single-use (consumed_at).
- **Sending email** goes through `sendAndLog` (`lib/notifications.ts`), which wraps `sendEmail` and writes to `notification_log`. For visit-bound emails (`visitId !== null`) the wrapper short-circuits if a prior row exists with the same `(visit_id, kind)` — DB-enforced idempotency. Magic-link rows have `visitId: null` and are always sent.
- **Templates** live in `lib/email/templates.ts` as pure `(props) => {subject, html, text}` functions. Add a new template by exporting another function; don't pull in a template engine.
- **Gmail API client** is `lib/gmail.ts`. Sends via service-account JWT → OAuth → REST POST. Falls back to a console-log stub when `GMAIL_SERVICE_ACCOUNT_JSON` is unset (local dev, tests).
- **Env vars added in Phase 2:** `SITE_URL`, `SESSION_SECRET`, `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SEND_AS`. Check `.env.example`.
- **Customer-enumeration safety:** endpoints that take an email and look it up (e.g., `POST /api/magic-link/send`) MUST always return 200/ok regardless of whether the email exists. Differentiating leaks the customer list to an attacker.
- **Workspace setup** for production Gmail send is documented in `docs/superpowers/plans/2026-05-27-phase-2-email-magiclink.md` Task 1. If a future session sees Gmail failing, start there.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase 2 auth + email conventions in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Production smoke test (AB action)

Once the code is pushed and Vercel has redeployed, AB exercises the real flow end-to-end.

- [ ] **Step 1: Wait for deploy**

After Task 13/14's commits are pushed (controller handles push), wait ~90s. Vercel dashboard → Deployments → latest should be green.

- [ ] **Step 2: Confirm health still works**

```bash
curl -s https://www.luckyshamrock.ca/api/health
```
Expected: `{"status":"ok","db":true,...}`. If 503, something broke in the deploy — investigate before continuing.

- [ ] **Step 3: Book yourself**

```bash
curl -s -X POST https://www.luckyshamrock.ca/api/book \
  -H 'Content-Type: application/json' \
  -d '{"name":"AB","email":"<your-real-email>","street":"<street>","city":"Fort Saskatchewan","postal_code":"T8L 1A1","pickup_day":"wednesday","bin_count":1,"plan":"monthly"}'
```

Replace `<your-real-email>` with a real inbox you control. Expected: 200 with customer_id + first_visit_date.

- [ ] **Step 4: Verify two emails actually arrived**

Check that inbox. Expected: two emails from `hello@luckyshamrock.ca`:
1. "You're booked with Lucky Shamrock"
2. "Your Lucky Shamrock manage link"

If they don't arrive in 30 seconds:
- Check Vercel function logs for the deploy. Errors there will mention `[book]`, `[email:stub]`, or Gmail API errors.
- If logs show `[email:stub]` instead of a real send: `GMAIL_SERVICE_ACCOUNT_JSON` env var didn't propagate to prod. Re-pull from Vercel and re-deploy.
- If logs show `gmail API 401`: Workspace domain-wide delegation isn't set up correctly. Revisit Task 1 Step 6.
- If logs show `gmail API 403`: scope wrong, must be exactly `https://www.googleapis.com/auth/gmail.send`.

- [ ] **Step 5: Click the manage link**

Click the link in email #2. Expected:
- Browser navigates to `https://www.luckyshamrock.ca/api/magic-link/verify?token=...`
- Then redirects to `https://www.luckyshamrock.ca/manage`
- `/manage` returns 404 (Phase 3 lands the page)
- But the session cookie is set — verify with DevTools → Application → Cookies. You should see `ls_session` set with HttpOnly, Secure, SameSite=Lax.

- [ ] **Step 6: Verify the token was consumed**

In Neon SQL Editor:
```sql
SELECT customer_id, consumed_at, expires_at FROM magic_link_token ORDER BY created_at DESC LIMIT 5;
```
Expected: the most recent token has `consumed_at` populated.

- [ ] **Step 7: Try to click the same link again**

Click the link from email #2 a second time. Expected: 400 with `{"status":"invalid","message":"token already used"}`.

- [ ] **Step 8: Verify notification_log rows landed**

In Neon SQL Editor:
```sql
SELECT kind, sent_at, failed_at, gmail_message_id, error FROM notification_log ORDER BY created_at DESC LIMIT 10;
```
Expected: two recent rows, kinds `booking_confirmed` and `magic_link`, both with `sent_at` set and `gmail_message_id` populated (real Gmail IDs, not `stub-...`). `failed_at` null, `error` null.

- [ ] **Step 9: Clean up your test booking**

```sql
-- replace email with the one you used
DELETE FROM notification_log WHERE customer_id IN (SELECT id FROM customer WHERE email = '<your-real-email>');
DELETE FROM magic_link_token WHERE customer_id IN (SELECT id FROM customer WHERE email = '<your-real-email>');
DELETE FROM visit WHERE customer_id IN (SELECT id FROM customer WHERE email = '<your-real-email>');
DELETE FROM subscription WHERE customer_id IN (SELECT id FROM customer WHERE email = '<your-real-email>');
DELETE FROM customer WHERE email = '<your-real-email>';
```

No commit (Neon admin only).

---

## Task 16: Update Obsidian session log + project note

This task has no code. It records the phase outcome.

- [ ] **Step 1: Update `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md`**

Change `**Status:**` to:
```
**Status:** 🚧 Phase 2 (Email + Magic Link) shipped <ABSOLUTE-DATE>. Real Gmail sends, magic-link auth working end-to-end. Phase 3 (manage page) next.
```

Append to `## Session Log`:
```markdown
### <ABSOLUTE-DATE> — Phase 2 (Email + Magic Link) shipped

- Workspace service account + domain-wide delegation set up by AB; `hello@luckyshamrock.ca` chosen as sender.
- Added 4 Vercel env vars: SITE_URL, SESSION_SECRET, GMAIL_SERVICE_ACCOUNT_JSON, GMAIL_SEND_AS.
- New pure-utility modules: `lib/tokens.ts` (random + SHA-256), `lib/cookies.ts` (HS256 JWT via jose, 30-day TTL), `lib/email/templates.ts` (4 templates: booking_confirmed, magic_link, on_our_way, done).
- New `lib/gmail.ts` (service-account JWT → OAuth → REST POST) with dev/test stub fallback when GMAIL_SERVICE_ACCOUNT_JSON is unset.
- `lib/notifications.ts` (`sendAndLog`) wraps email send with notification_log write + DB-enforced idempotency on (visit_id, kind).
- 2 new endpoints: `POST /api/magic-link/send` (no enumeration leak — always 200/ok) and `GET /api/magic-link/verify` (consumes token, sets HS256 session cookie, redirects to /manage).
- `/api/book` rewired to use real magic_link tokens + sendAndLog. Now catches Postgres 23505 unique-violation on customer.email and returns clean 409.
- ~14 commits, ~92 tests passing across ~15 files.
- Production smoke verified end-to-end: real email lands in inbox, magic-link click sets session cookie, second click rejected as already-used, notification_log rows correct.
- **Next:** Phase 3 — `/manage` page (customer self-service: view bookings, skip a visit, change plan, cancel subscription), session-protected routes, `/api/me`, `/api/visit/:id/skip`, `/api/subscription/:id/cancel`, sliding session renewal.
```

- [ ] **Step 2: Update `_Index.md`**

In `~/Documents/My Brain/Projects/_Index.md`, change the Lucky Shamrock row to:
```
🚧 Phase 2 (Email + Magic Link) shipped <ABSOLUTE-DATE>. Real Gmail sends, magic-link auth working end-to-end. Phase 3 (manage page) next.
```

No commit (Obsidian is separate).

---

## Self-Review (for the executor)

After all 16 tasks, before declaring Phase 2 done:

- [ ] `npm test` reports ~92 tests passing (49 from Phase 1 + ~43 added in Phase 2)
- [ ] `npm run typecheck` exits 0
- [ ] Production smoke test from Task 15: real email arrives, magic link works, cookie set, consumed_at populated
- [ ] CLAUDE.md updated with Phase 2 conventions
- [ ] Obsidian project note + index row updated

If any check fails, do not declare Phase 2 complete.

---

## What this plan deliberately does NOT do

Phase 3 territory:

- The `/manage` page itself (HTML + JS to list bookings, show skip/cancel buttons)
- `GET /api/me`, `POST /api/visit/:id/skip`, `POST /api/subscription/:id/cancel`, `POST /api/subscription/:id/update`, `POST /api/logout`
- Sliding session renewal (each `/api/me` call extends the cookie)
- Auth middleware that reads `ls_session` and rejects unauthenticated requests

Phase 4-5 territory:

- Operator dashboard (`/ops`, `/api/operator/*`)
- Day-before reminder cron
- Real photo capture, SMS, payments

---

## Phase 3 prep notes

Pulling forward what Phase 3 will need:

- **`ls_session` cookie is set in Phase 2 by `/api/magic-link/verify`.** Phase 3's `/api/me` and similar reads the cookie, calls `verifySessionCookie(token)`, and either returns the customer's data or 401.
- **Sliding renewal:** when `/api/me` is hit and the cookie is in the second half of its TTL, re-sign with a fresh `exp` and re-set the cookie header. Simple — `lib/cookies.ts` already has all the pieces.
- **Wrap `/api/book` writes in `db.transaction(...)`** is STILL deferred (carried forward from Phase 1). Phase 3 will introduce mutations from `/manage` that absolutely should be transactional (e.g., cancelling a subscription + voiding scheduled visits). Do the transaction work then.
- **Email "from name":** Gmail uses the sender address as the visible name. If AB wants `Lucky Shamrock <hello@luckyshamrock.ca>` instead of just the email, add it in `lib/gmail.ts` `buildRfc822Message`'s `From:` line. Trivial 1-line change.
- **Magic-link rate limiting:** Phase 2 has no rate limit on `POST /api/magic-link/send`. Someone could spam an email. Phase 3 or Phase 5 should add a simple per-IP or per-email bucket (10/hour is generous).
